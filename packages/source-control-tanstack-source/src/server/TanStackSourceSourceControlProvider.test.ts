import { assert, describe, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as TanStackSourceApi from "./TanStackSourceApi.ts";
import * as TanStackSourceSourceControlProvider from "./TanStackSourceSourceControlProvider.ts";

const REMOTE = "https://source.tanstack.com/@acme/web.git";
const OWNER_KEY = "branch.pr-42.t3TanstackSourcePull";

/** Pull request #42 of acme/web, opened from a fork, so it checks out as `pr-42`. */
const PULL = {
  number: 42,
  title: "Fix the thing",
  state: "open",
  draft: false,
  author: "bob",
  head: "fix-thing",
  createdAt: 1_000,
  body: null,
  base: "main",
  headRepo: "bob/web",
  headSha: "c".repeat(40),
  baseSha: "b".repeat(40),
  mergeCommitSha: null,
  mergedAt: null,
  mergedBy: null,
  mergeable: null,
  changedFiles: null,
};

function checkout(options: {
  readonly recordedOwner: string | null;
  readonly isAncestor: boolean;
  readonly pull?: Partial<typeof PULL>;
  readonly force?: boolean;
}) {
  const git: Array<string> = [];
  const config = new Map<string, string>(
    options.recordedOwner === null ? [] : [[OWNER_KEY, options.recordedOwner]],
  );
  const api = TanStackSourceApi.TanStackSourceApi.of({
    request: (input) =>
      input.path === "/repos/acme/web/pulls/42"
        ? Effect.succeed(JSON.stringify({ ...PULL, ...options.pull }))
        : Effect.die(`unexpected ${input.path}`),
    response: () => Effect.die("unexpected response read"),
  });
  const host = TestSourceControlHost.layer({
    git: {
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      ensureRemote: (input) =>
        Effect.sync(() => {
          git.push(`remote ${input.preferredName} ${input.url}`);
          return input.url === REMOTE ? "origin" : input.preferredName;
        }),
      fetchRemoteBranch: (input) =>
        Effect.sync(
          () =>
            void git.push(`fetch ${input.remoteName} ${input.remoteBranch}:${input.localBranch}`),
        ),
      fetchRemoteTrackingBranch: () => Effect.void,
      setBranchUpstream: (input) =>
        Effect.sync(
          () => void git.push(`upstream ${input.branch} ${input.remoteName}/${input.remoteBranch}`),
        ),
      readConfigValue: (_cwd, key) =>
        Effect.succeed(key === "remote.origin.url" ? REMOTE : (config.get(key) ?? null)),
      writeConfigValue: (input) => Effect.sync(() => void config.set(input.key, input.value)),
      listLocalBranchNames: () => Effect.succeed(["main", "pr-42"]),
      createBranch: (input) => Effect.sync(() => void git.push(`create ${input.branch}`)),
      switchRef: (input) =>
        Effect.sync(() => {
          git.push(`switch ${input.refName}`);
          return { refName: input.refName };
        }),
      execute: (input) =>
        input.args[0] === "merge-base" && !options.isAncestor
          ? Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: "git",
                cwd: input.cwd,
                argumentCount: input.args.length,
                exitCode: 1,
                detail: "not an ancestor",
              }),
            )
          : Effect.sync(() => {
              git.push(input.args.join(" "));
              return {
                exitCode: 0,
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              } as never;
            }),
    },
  });
  const run = TanStackSourceSourceControlProvider.make.pipe(
    Effect.flatMap((provider) =>
      provider.checkoutChangeRequest({
        cwd: "/repo",
        reference: "42",
        ...(options.force === undefined ? {} : { force: options.force }),
      }),
    ),
    Effect.provideService(TanStackSourceApi.TanStackSourceApi, api),
    Effect.provide(Layer.merge(host, FileSystem.layerNoop({}))),
  );
  return { run, git, config };
}

describe("TanStackSourceSourceControlProvider.checkoutChangeRequest", () => {
  it.effect(
    "refuses a pr-<n> branch T3 did not make for this pull request, and leaves it alone",
    () => {
      // An unrelated branch at the pull request's base is an ancestor of its head.
      const { run, git, config } = checkout({ recordedOwner: null, isAncestor: true });
      return Effect.gen(function* () {
        const error = yield* Effect.flip(run);
        assert.include(error.detail, "pr-42 was not made for pull request #42");
        assert.isFalse(
          git.some((command) => command.startsWith("checkout") || command.startsWith("switch")),
        );
        assert.isFalse(config.has(OWNER_KEY));
      });
    },
  );

  it.effect("moves the branch it made for the pull request up to the new head", () => {
    const { run, git } = checkout({ recordedOwner: "acme/web#42", isAncestor: true });
    return Effect.gen(function* () {
      yield* run;
      assert.deepStrictEqual(
        git.filter((command) => /^(checkout|switch|create) /u.test(command)),
        ["checkout --no-track -B pr-42 refs/remotes/origin/pull/42 --", "switch pr-42"],
      );
    });
  });

  it.effect("keeps local commits on its own branch rather than moving it", () => {
    const { run, git } = checkout({ recordedOwner: "acme/web#42", isAncestor: false });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(run);
      assert.include(error.detail, "has commits pull request #42 does not");
      assert.isFalse(git.some((command) => command.startsWith("checkout")));
    });
  });

  // Source publishes no `refs/pull/<n>/head` for a private pull request, on either repository.
  it.effect("takes a private pull request's branch from the companion repository", () => {
    const pull = { head: "acme:fix-thing", headRepo: "acme/web.private" };
    const { run, git, config } = checkout({ recordedOwner: null, isAncestor: true, pull });
    const forced = checkout({ recordedOwner: null, isAncestor: true, pull, force: true });
    return Effect.gen(function* () {
      yield* forced.run;
      assert.include(forced.git, "checkout --no-track -B fix-thing refs/remotes/acme/fix-thing --");
      yield* run;
      assert.strictEqual(config.get("branch.fix-thing.pushRemote"), "acme");
      assert.deepStrictEqual(git, [
        `remote source ${REMOTE}`,
        "remote acme https://source.tanstack.com/@acme/web.private.git",
        "fetch acme fix-thing:fix-thing",
        "upstream fix-thing acme/fix-thing",
        "switch fix-thing",
      ]);
    });
  });
});

describe("TanStackSourceSourceControlProvider private pull requests", () => {
  it.effect("asks Source for the companion and opens the pull request as private", () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const api = TanStackSourceApi.TanStackSourceApi.of({
      request: (input) => {
        requests.push({ method: input.method ?? "GET", path: input.path, body: input.body });
        return Effect.succeed(
          JSON.stringify({
            owner: "acme",
            name: "web.private",
            defaultBranch: null,
            cloneUrl: "https://source.tanstack.com/@acme/web.private.git",
          }),
        );
      },
      response: () => Effect.die("unexpected response read"),
    });
    const files = FileSystem.layerNoop({ readFileString: () => Effect.succeed("Body") });
    return Effect.gen(function* () {
      const provider = yield* TanStackSourceSourceControlProvider.make;
      const companion = provider.privateChangeRequestRemote;
      assert.isDefined(companion);
      assert.deepStrictEqual(yield* companion({ cwd: "/repo" }), {
        url: "https://source.tanstack.com/@acme/web.private.git",
        repository: "acme/web.private",
      });
      yield* provider.createChangeRequest({
        cwd: "/repo",
        baseRefName: "main",
        headSelector: "sec/fix",
        title: "Fix",
        bodyFile: "/tmp/body.md",
        private: true,
      });
      assert.deepStrictEqual(requests, [
        { method: "POST", path: "/repos/acme/web/private-remote", body: undefined },
        {
          method: "POST",
          path: "/repos/acme/web/pulls",
          body: { title: "Fix", head: "sec/fix", base: "main", body: "Body", private: true },
        },
      ]);
    }).pipe(
      Effect.provideService(TanStackSourceApi.TanStackSourceApi, api),
      Effect.provide(
        Layer.merge(
          TestSourceControlHost.layer({
            git: {
              resolvePrimaryRemoteName: () => Effect.succeed("origin"),
              readConfigValue: () => Effect.succeed(REMOTE),
            },
          }),
          files,
        ),
      ),
    );
  });
});
