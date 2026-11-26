import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const gitWorkflowTestLayer = GitWorkflowService.layer.pipe(
  Layer.provide(
    Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
    }),
  ),
  Layer.provide(Layer.mock(GitManager.GitManager)({})),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-workflow-" }).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("GitWorkflowService", (it) => {
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(Effect.scoped, Effect.provide(gitWorkflowTestLayer)),
  );

  it.effect("safely deletes a merged local branch and invalidates cached refs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-delete-branch-" });
      const worktree = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-delete-worktree-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const commit = ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m"];
      for (const args of [
        ["init", "-b", "main"],
        [...commit, "init"],
        ["branch", "merged"],
        ["remote", "add", "origin", cwd],
        ["update-ref", "refs/remotes/origin/merged", "HEAD"],
        ["worktree", "add", "-b", "checked-out", worktree],
        ["switch", "-c", "unmerged"],
        [...commit, "unmerged"],
        ["switch", "main"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }

      const listNames = () =>
        driver
          .listRefs({ cwd, includeMatchingRemoteRefs: true })
          .pipe(Effect.map(({ refs }) => refs.map(({ name }) => name).sort()));
      assert.deepEqual(yield* listNames(), [
        "checked-out",
        "main",
        "merged",
        "origin/merged",
        "unmerged",
      ]);

      yield* workflow.deleteLocalBranch({ cwd, refName: "merged" });
      assert.deepEqual(yield* listNames(), ["checked-out", "main", "origin/merged", "unmerged"]);

      for (const [refName, reason] of [
        ["main", "branch_checked_out_in_worktree"],
        ["checked-out", "branch_checked_out_in_worktree"],
        ["unmerged", "branch_not_fully_merged"],
        ["origin/merged", "ref_not_found"],
      ] as const) {
        const error = yield* Effect.flip(workflow.deleteLocalBranch({ cwd, refName }));
        assert.strictEqual(error.reason, reason);
      }
      assert.deepEqual(yield* listNames(), ["checked-out", "main", "origin/merged", "unmerged"]);
    }).pipe(Effect.scoped, Effect.provide(gitWorkflowTestLayer)),
  );

  it.effect("reads no HEAD path from a removed worktree without spawning Git", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-removed-wt-" });
      const removed = `${parent}/removed`;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.strictEqual(yield* workflow.headPath(removed), null);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              execute: (input) => Effect.die(`spawned Git in ${input.cwd}`),
            }),
          ),
        ),
      ),
    ),
  );
});
