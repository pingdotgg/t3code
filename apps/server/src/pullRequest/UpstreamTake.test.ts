// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";

import { type GitCommandError, SourceControlProviderKind } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as UpstreamTake from "./UpstreamTake.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(Layer.orDie(ServerSettings.layerTest())),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cherry-pick-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  allowNonZeroExit = false,
): Effect.Effect<
  { readonly exitCode: number | null; readonly stdout: string },
  GitCommandError,
  GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* git.execute({
      operation: "UpstreamTake.test.runGit",
      cwd,
      args,
      allowNonZeroExit,
    });
    return { exitCode: result.exitCode, stdout: result.stdout };
  });
}

function commitFile(cwd: string, path: string, contents: string, message: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(NodePath.join(cwd, path), contents);
    yield* runGit(cwd, ["add", path]);
    yield* runGit(cwd, ["commit", "-m", message]);
  });
}

/**
 * An upstream repository with a change request open on it, and a fork of it that has moved on.
 *
 * `refs/pull/<n>/head` is written by hand because that is exactly what GitHub publishes and what
 * the pick fetches — a branch would not do, since a fork can only reach a change request through
 * that ref.
 *
 * The fetch source is found by matching a remote against `host/repository`, so the fixture spells
 * those two as the upstream checkout's own path: the service treats them as opaque names for a
 * repository, and a local path is what a remote pointing at this one normalizes to.
 */
function makeFixture(input: { readonly forkChange: string | null }) {
  return Effect.gen(function* () {
    const upstream = yield* makeTempDir("t3code-cherry-pick-upstream-");
    yield* runGit(upstream, ["init", "--initial-branch=main"]);
    yield* runGit(upstream, ["config", "user.email", "upstream@example.com"]);
    yield* runGit(upstream, ["config", "user.name", "Upstream"]);
    yield* commitFile(upstream, "shared.txt", "one\n", "Initial commit");
    yield* runGit(upstream, ["checkout", "-b", "feature"]);
    yield* commitFile(upstream, "shared.txt", "one\ntwo from upstream\n", "Add two");
    const headSha = yield* runGit(upstream, ["rev-parse", "HEAD"]).pipe(
      Effect.map((result) => result.stdout.trim()),
    );
    yield* runGit(upstream, ["update-ref", "refs/pull/7/head", headSha]);
    yield* runGit(upstream, ["checkout", "main"]);

    const fork = yield* makeTempDir("t3code-cherry-pick-fork-");
    yield* runGit(fork, ["clone", upstream, "."]);
    yield* runGit(fork, ["config", "user.email", "fork@example.com"]);
    yield* runGit(fork, ["config", "user.name", "Fork"]);
    if (input.forkChange !== null) {
      yield* commitFile(fork, "shared.txt", input.forkChange, "The fork's own change");
    }

    // The clone's own remote already points at the upstream path, so the pick finds it there
    // rather than deriving an address for a repository nothing here has talked to.
    const repository = upstream.split("/").slice(-2).join("/");
    return {
      upstream,
      fork,
      request: {
        cwd: fork,
        provider: SourceControlProviderKind.make("github"),
        host: upstream.slice(0, upstream.length - repository.length - 1),
        repository,
        number: 7,
        baseBranch: "main",
      },
    };
  });
}

const cherryPickService = UpstreamTake.make.pipe(
  Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
    runForThread: () => Effect.succeed({ status: "no-script" as const }),
  }),
);

it.layer(TestLayer)("UpstreamTake", (it) => {
  it.effect("takes the commits onto a branch and worktree of their own", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ forkChange: null });
      const service = yield* cherryPickService;

      const result = yield* service.cherryPick(fixture.request);

      expect(result.status).toBe("applied");
      expect(result.commits).toBe(1);
      expect(result.branch).toBe("t3code/cherry-pick/pr-7");
      expect(result.conflictedPaths).toEqual([]);
      const worktreePath = result.worktreePath!;
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readFileString(NodePath.join(worktreePath, "shared.txt"))).toBe(
        "one\ntwo from upstream\n",
      );
      // Where it came from, which is the only trace left once the branch is squashed.
      const message = yield* runGit(worktreePath, ["log", "-1", "--format=%B"]).pipe(
        Effect.map((r) => r.stdout),
      );
      expect(message).toContain("cherry picked from commit");
      // The tree the developer is working in is untouched: still on its own branch, still theirs.
      const forkBranch = yield* runGit(fixture.fork, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(forkBranch).toBe("main");
      expect(yield* fs.readFileString(NodePath.join(fixture.fork, "shared.txt"))).toBe("one\n");
    }),
  );

  it.effect("leaves a conflicted pick standing, and says what collided", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ forkChange: "one\ntwo from the fork\n" });
      const service = yield* cherryPickService;

      const result = yield* service.cherryPick(fixture.request);

      expect(result.status).toBe("conflicted");
      expect(result.conflictedPaths).toEqual(["shared.txt"]);
      expect(result.conflictedPathCount).toBe(1);
      // Mid-pick rather than rolled back: finishing it is the whole point of handing it over.
      const worktreePath = result.worktreePath!;
      const inProgress = yield* runGit(
        worktreePath,
        ["rev-parse", "--verify", "CHERRY_PICK_HEAD"],
        true,
      );
      expect(inProgress.exitCode).toBe(0);
    }),
  );

  it.effect("reports nothing to take when the commits are already here", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ forkChange: null });
      const service = yield* cherryPickService;
      // The fork takes the change the ordinary way first, so the pick has nothing left to do.
      yield* runGit(fixture.fork, ["fetch", fixture.upstream, "refs/pull/7/head"]);
      yield* runGit(fixture.fork, ["merge", "--ff-only", "FETCH_HEAD"]);

      const result = yield* service.cherryPick(fixture.request);

      expect(result.status).toBe("empty");
      expect(result.worktreePath).toBeNull();
      expect(result.branch).toBeNull();
      expect(result.commits).toBe(0);
      // Nothing was created to clean up later.
      const branches = yield* runGit(fixture.fork, ["branch", "--list", "t3code/*"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(branches).toBe("");
    }),
  );

  it.effect("merges an upstream release onto a branch of its own", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ forkChange: null });
      const service = yield* cherryPickService;
      // A release the fork has never seen: the upstream ships something on main and tags it.
      yield* runGit(fixture.upstream, ["checkout", "main"]);
      yield* commitFile(fixture.upstream, "released.txt", "shipped\n", "Ship it");
      yield* runGit(fixture.upstream, ["tag", "v1.2.3"]);

      const result = yield* service.mergeRelease({
        cwd: fixture.fork,
        host: fixture.request.host,
        repository: fixture.request.repository,
        tagName: "v1.2.3",
      });

      expect(result.status).toBe("merged");
      expect(result.branch).toBe("t3code/upstream/v1.2.3");
      expect(result.behindBy).toBe(1);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readFileString(NodePath.join(result.worktreePath!, "released.txt"))).toBe(
        "shipped\n",
      );
      // A merge, so the fork's own history is still under it rather than replaced by the tag.
      const parents = yield* runGit(result.worktreePath!, ["log", "-1", "--format=%P"]).pipe(
        Effect.map((r) => r.stdout.trim().split(" ")),
      );
      expect(parents).toHaveLength(2);
    }),
  );

  it.effect("says a release is already here rather than making a branch for it", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ forkChange: null });
      const service = yield* cherryPickService;
      // Tagged at the commit the fork was cloned from, so its history already contains it.
      yield* runGit(fixture.upstream, ["checkout", "main"]);
      yield* runGit(fixture.upstream, ["tag", "v1.0.0"]);

      const result = yield* service.mergeRelease({
        cwd: fixture.fork,
        host: fixture.request.host,
        repository: fixture.request.repository,
        tagName: "v1.0.0",
      });

      expect(result.status).toBe("up-to-date");
      expect(result.worktreePath).toBeNull();
      expect(result.branch).toBeNull();
      const branches = yield* runGit(fixture.fork, ["branch", "--list", "t3code/*"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(branches).toBe("");
    }),
  );

  it.effect("leaves a conflicting release merge standing, and says what collided", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ forkChange: "one\nthe fork's own line\n" });
      const service = yield* cherryPickService;
      yield* runGit(fixture.upstream, ["checkout", "main"]);
      yield* commitFile(fixture.upstream, "shared.txt", "one\nupstream's own line\n", "Change it");
      yield* runGit(fixture.upstream, ["tag", "v2.0.0"]);

      const result = yield* service.mergeRelease({
        cwd: fixture.fork,
        host: fixture.request.host,
        repository: fixture.request.repository,
        tagName: "v2.0.0",
      });

      expect(result.status).toBe("conflicted");
      expect(result.conflictedPaths).toEqual(["shared.txt"]);
      const inProgress = yield* runGit(
        result.worktreePath!,
        ["rev-parse", "--verify", "MERGE_HEAD"],
        true,
      );
      expect(inProgress.exitCode).toBe(0);
    }),
  );

  it.effect("refuses a host that publishes no commits to fetch", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ forkChange: null });
      const service = yield* cherryPickService;

      const failure = yield* service
        .cherryPick({ ...fixture.request, provider: SourceControlProviderKind.make("bitbucket") })
        .pipe(Effect.flip);

      expect(failure.detail).toContain("does not publish");
      expect(failure.detail).toContain("Implement the change instead");
    }),
  );

  it.effect("names the base branch when it can no longer be read", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ forkChange: null });
      const service = yield* cherryPickService;

      const failure = yield* service
        .cherryPick({ ...fixture.request, baseBranch: "branch-that-was-deleted" })
        .pipe(Effect.flip);

      expect(failure.detail).toContain("branch-that-was-deleted");
    }),
  );
});
