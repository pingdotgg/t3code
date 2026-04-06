import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError } from "effect";
import { describe, expect } from "vitest";

import { GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { initJjRepo, makeTempDir, writeTextFile } from "../../jj/Layers/JjTestUtils.ts";
import { JjCoreLive } from "../../jj/Layers/JjCore.ts";
import { VcsCore } from "../Services/VcsCore.ts";
import { VcsCoreLive } from "./VcsCore.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-vcs-core-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const JjCoreTestLayer = JjCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(GitCoreTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const VcsCoreTestLayer = VcsCoreLive.pipe(
  Layer.provideMerge(GitCoreTestLayer),
  Layer.provideMerge(JjCoreTestLayer),
);
const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  GitCoreTestLayer,
  JjCoreTestLayer,
  VcsCoreTestLayer,
);

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const result = yield* gitCore.execute({
      operation: "VcsCore.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initGitRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@example.com"]);
    yield* git(cwd, ["config", "user.name", "Test User"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "hello\n");
    yield* git(cwd, ["add", "README.md"]);
    yield* git(cwd, ["commit", "-m", "Initial commit"]);
  });
}

it.layer(TestLayer)("VcsCore", (it) => {
  describe("routing", () => {
    it.effect("routes git repositories through the generic VCS interface", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir("t3-vcs-core-git-");
        yield* initGitRepoWithCommit(cwd);
        yield* writeTextFile(path.join(cwd, "git-change.txt"), "git change\n");

        const vcs = yield* VcsCore;
        const status = yield* vcs.statusDetails(cwd);
        const branches = yield* vcs.listLocalBranchNames(cwd);

        expect(status.isRepo).toBe(true);
        expect(status.branch).toBeTruthy();
        expect(status.hasWorkingTreeChanges).toBe(true);
        expect(branches.length).toBeGreaterThan(0);
      }),
    );

    it.effect(
      "routes jj repositories through the generic VCS interface and tracks new files natively",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTempDir("t3-vcs-core-jj-");
          yield* initJjRepo(cwd);
          yield* writeTextFile(path.join(cwd, "native.txt"), "native jj\n");

          const vcs = yield* VcsCore;
          const context = yield* vcs.prepareCommitContext(cwd);
          expect(context?.stagedSummary).toContain("A native.txt");

          yield* vcs.commit(cwd, "Add native file", "");

          const status = yield* vcs.statusDetails(cwd);
          const branches = yield* vcs.listLocalBranchNames(cwd);

          expect(status.isRepo).toBe(true);
          expect(status.branch).toBe("main");
          expect(status.hasWorkingTreeChanges).toBe(false);
          expect(branches).toContain("main");
        }),
    );
  });
});
