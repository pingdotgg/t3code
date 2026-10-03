// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

/**
 * What the projection and project store hold for one deleted thread. Tests
 * register the thread here, so the shared layer serves each test its own rows
 * and a thread that is missing reads as already pruned.
 */
interface SeededThread {
  readonly workspaceRoot: string | null;
  readonly scopes: ReadonlyArray<{ readonly cwd: string; readonly refs: ReadonlyArray<string> }>;
  readonly orphanRefs?: ReadonlyArray<string>;
}
const seeded = new Map<string, SeededThread>();
let seedCount = 0;
const seed = (thread: SeededThread) => {
  const threadId = ThreadId.make(`thread:cleanup-${(seedCount += 1)}`);
  seeded.set(threadId, thread);
  return threadId;
};
const recordsFor = (threadId: ThreadId) => {
  const thread = seeded.get(threadId);
  if (thread === undefined) {
    return Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }));
  }
  const scopes = thread.scopes.map((scope, index) => ({
    id: CheckpointScopeId.make(`${threadId}:scope:${index}`),
    cwd: scope.cwd,
    refs: scope.refs,
  }));
  const checkpoints = [
    ...scopes.flatMap((scope) =>
      scope.refs.map((ref, index) => ({
        id: CheckpointId.make(`${scope.id}:checkpoint:${index}`),
        scopeId: scope.id,
        ref: CheckpointRef.make(ref),
      })),
    ),
    ...(thread.orphanRefs ?? []).map((ref, index) => ({
      id: CheckpointId.make(`${threadId}:orphan:${index}`),
      scopeId: CheckpointScopeId.make(`${threadId}:scope:unknown`),
      ref: CheckpointRef.make(ref),
    })),
  ];
  return Effect.succeed({
    thread: { id: threadId, projectId: ProjectId.make(`project:${threadId}`) },
    checkpointScopes: scopes.map(({ id, cwd }) => ({ id, cwd })),
    checkpoints,
  } as never);
};
const projectFor = (projectId: ProjectId) => {
  const threadId = projectId.replace(/^project:/, "");
  const workspaceRoot = seeded.get(threadId)?.workspaceRoot ?? null;
  return Effect.succeed(
    workspaceRoot === null ? Option.none() : Option.some({ workspaceRoot } as never),
  );
};

const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer))),
);
const TestLayer = ResourceCleanupService.live.pipe(
  Layer.provide(Layer.mock(TerminalManager.TerminalManager)({})),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-cleanup-test-" })),
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadRecords: recordsFor as never }),
  ),
  Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({ get: projectFor })),
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

const git = Effect.fn(function* (cwd: string, args: ReadonlyArray<string>) {
  const process = yield* VcsProcess.VcsProcess;
  const result = yield* process.run({
    operation: "ResourceCleanupService.test.git",
    command: "git",
    cwd,
    args,
    timeoutMs: 10_000,
  });
  return result.stdout.trim();
});

const initRepo = Effect.fn(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* git(cwd, ["init"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(NodePath.join(cwd, "README.md"), "# test\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "initial commit"]);
});

const ref = (name: string) => `refs/t3/orchestration-v2/checkpoints/${name}`;
const listCheckpointRefs = (cwd: string) =>
  git(cwd, ["for-each-ref", "--format=%(refname)", "refs/t3/"]);

it.layer(TestLayer)("ResourceCleanupService.cleanupCheckpointRefs", (it) => {
  it.effect("deletes only the recorded refs, including packed ones, and is idempotent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cleanup-refs-" });
      yield* initRepo(cwd);
      for (const name of ["deleted/ordinal/0", "deleted/ordinal/1", "kept/ordinal/0"]) {
        yield* git(cwd, ["update-ref", ref(name), "HEAD"]);
      }
      yield* git(cwd, ["pack-refs", "--all"]);
      // The project root is also the scope cwd, so there is one target.
      const threadId = seed({
        workspaceRoot: cwd,
        scopes: [
          { cwd, refs: [ref("deleted/ordinal/0"), ref("deleted/ordinal/1"), ref("never/existed")] },
        ],
        orphanRefs: [ref("kept/ordinal/0")],
      });
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      yield* cleanup.cleanupCheckpointRefs(threadId);
      yield* cleanup.cleanupCheckpointRefs(threadId);
      // A checkpoint whose scope is unknown has no cwd to clean.
      assert.strictEqual(yield* listCheckpointRefs(cwd), ref("kept/ordinal/0"));
      assert.strictEqual(yield* git(cwd, ["status", "--porcelain"]), "");
    }),
  );

  it.effect("reads the refs when it runs, and a pruned thread is a no-op", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cleanup-late-" });
      yield* initRepo(cwd);
      yield* git(cwd, ["update-ref", ref("late/ordinal/0"), "HEAD"]);
      yield* git(cwd, ["update-ref", ref("late/ordinal/1"), "HEAD"]);
      const threadId = seed({
        workspaceRoot: null,
        scopes: [{ cwd, refs: [ref("late/ordinal/0")] }],
      });
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      yield* cleanup.cleanupCheckpointRefs(threadId);
      assert.strictEqual(yield* listCheckpointRefs(cwd), ref("late/ordinal/1"));
      // A capture that landed after the deletion was planned is recorded by
      // the time the effect runs again.
      seeded.set(threadId, {
        workspaceRoot: null,
        scopes: [{ cwd, refs: [ref("late/ordinal/0"), ref("late/ordinal/1")] }],
      });
      yield* cleanup.cleanupCheckpointRefs(threadId);
      assert.strictEqual(yield* listCheckpointRefs(cwd), "");
      yield* cleanup.cleanupCheckpointRefs(ThreadId.make("thread:cleanup-pruned"));
    }),
  );

  it.effect("skips targets whose directory is gone or is not a repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cleanup-repo-" });
      yield* initRepo(repo);
      yield* git(repo, ["update-ref", ref("deleted/ordinal/0"), "HEAD"]);
      const plain = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cleanup-plain-" });
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      yield* cleanup.cleanupCheckpointRefs(
        seed({
          workspaceRoot: plain,
          scopes: [{ cwd: NodePath.join(plain, "removed-worktree"), refs: [ref("x/ordinal/0")] }],
        }),
      );
      yield* cleanup.cleanupCheckpointRefs(
        seed({ workspaceRoot: null, scopes: [{ cwd: repo, refs: [ref("deleted/ordinal/0")] }] }),
      );
      assert.strictEqual(yield* listCheckpointRefs(repo), "");
    }),
  );

  it.effect("deletes a removed worktree's refs through the project root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cleanup-root-" });
      yield* initRepo(root);
      const worktree = NodePath.join(root, ".worktrees", "feature");
      yield* git(root, ["worktree", "add", "-b", "feature", worktree]);
      yield* git(worktree, ["update-ref", ref("deleted/ordinal/0"), "HEAD"]);
      yield* git(root, ["update-ref", ref("kept/ordinal/0"), "HEAD"]);
      assert.strictEqual(
        yield* listCheckpointRefs(root),
        [ref("deleted/ordinal/0"), ref("kept/ordinal/0")].join("\n"),
      );
      yield* git(root, ["worktree", "remove", "--force", worktree]);
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      yield* cleanup.cleanupCheckpointRefs(
        seed({
          workspaceRoot: root,
          scopes: [{ cwd: worktree, refs: [ref("deleted/ordinal/0")] }],
        }),
      );
      assert.strictEqual(yield* listCheckpointRefs(root), ref("kept/ordinal/0"));
    }),
  );

  it.effect("fails on a held lock after trying every target, and a retry finishes the job", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const locked = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cleanup-locked-" });
      yield* initRepo(locked);
      yield* git(locked, ["update-ref", ref("deleted/ordinal/0"), "HEAD"]);
      const lockPath = NodePath.join(locked, ".git", `${ref("deleted/ordinal/0")}.lock`);
      yield* fileSystem.writeFileString(lockPath, "");
      const free = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cleanup-free-" });
      yield* initRepo(free);
      yield* git(free, ["update-ref", ref("deleted/ordinal/0"), "HEAD"]);
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      const threadId = seed({
        workspaceRoot: null,
        scopes: [
          { cwd: locked, refs: [ref("deleted/ordinal/0")] },
          { cwd: free, refs: [ref("deleted/ordinal/0")] },
        ],
      });

      const result = yield* Effect.result(cleanup.cleanupCheckpointRefs(threadId));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.operation, "checkpoint");
        assert.strictEqual(result.failure.cwd, locked);
      }
      assert.strictEqual(yield* listCheckpointRefs(locked), ref("deleted/ordinal/0"));
      assert.strictEqual(yield* listCheckpointRefs(free), "");

      yield* fileSystem.remove(lockPath);
      yield* cleanup.cleanupCheckpointRefs(threadId);
      assert.strictEqual(yield* listCheckpointRefs(locked), "");
    }),
  );

  it.effect("never deletes refs outside the checkpoint namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cleanup-guard-" });
      yield* initRepo(cwd);
      yield* git(cwd, ["branch", "victim"]);
      yield* git(cwd, ["update-ref", ref("deleted/ordinal/0"), "HEAD"]);
      // A symbolic ref planted in our namespace must go, not the branch it points at.
      yield* git(cwd, ["symbolic-ref", ref("deleted/ordinal/1"), "refs/heads/victim"]);
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      yield* cleanup.cleanupCheckpointRefs(
        seed({
          workspaceRoot: null,
          scopes: [
            {
              cwd,
              refs: ["refs/heads/victim", ref("deleted/ordinal/0"), ref("deleted/ordinal/1")],
            },
          ],
        }),
      );
      assert.strictEqual(yield* listCheckpointRefs(cwd), "");
      assert.strictEqual(
        yield* git(cwd, ["rev-parse", "--verify", "refs/heads/victim"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );
    }),
  );
});
