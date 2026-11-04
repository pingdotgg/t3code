import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProjectStoreV2 } from "./ProjectStore.ts";

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

const layerVcsProcess = VcsProcess.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layerGitCheckpoints = CheckpointService.layer.pipe(
  Layer.provide(IdAllocator.layer),
  Layer.provide(CheckpointStore.layer),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  Layer.provideMerge(layerVcsProcess),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-checkpoint-service-" }),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

// Turn 1 runs in worktree A, then the thread moves to worktree B (a branch with its own
// committed file) of the same repository, and turn 2 adds one file there.
const runTurnsAcrossWorktrees = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    vcsProcess.run({ operation: "CheckpointService.test.git", command: "git", cwd, args });
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-worktrees-" }),
  );
  const repo = path.join(root, "repo");
  const worktreeA = path.join(root, "worktree-a");
  const worktreeB = path.join(root, "worktree-b");
  yield* fileSystem.makeDirectory(repo);
  yield* git(repo, "init", "--initial-branch=main");
  yield* git(repo, "config", "user.email", "test@test.com");
  yield* git(repo, "config", "user.name", "Test");
  yield* fileSystem.writeFileString(path.join(repo, "shared.txt"), "shared\n");
  yield* git(repo, "add", ".");
  yield* git(repo, "commit", "-m", "initial");
  yield* git(repo, "worktree", "add", "-b", "branch-a", worktreeA);
  yield* git(repo, "worktree", "add", "-b", "branch-b", worktreeB);
  yield* fileSystem.writeFileString(path.join(worktreeB, "b-only.txt"), "only on branch b\n");
  yield* git(worktreeB, "add", ".");
  yield* git(worktreeB, "commit", "-m", "branch b work");

  const threadId = ThreadId.make("thread:worktree-move");
  const providerThreadId = ProviderThreadId.make("provider-thread:worktree-move");
  const createdAt = DateTime.makeUnsafe("2026-11-04T00:00:00.000Z");
  // Scopes are projected by id; a later run's scope record replaces an earlier one with that id.
  const projectedScopes = new Map<CheckpointScopeId, OrchestrationV2CheckpointScope>();
  const runTurn = Effect.fn("runTurn")(function* (ordinal: number, cwd: string, file: string) {
    const runId = RunId.make(`run:worktree-move:${ordinal}`);
    const nodeId = NodeId.make(`node:worktree-move:${ordinal}`);
    const scope = yield* checkpoints.prepareRootRunScope({
      threadId,
      runId,
      rootNodeId: nodeId,
      providerThreadId,
      cwd,
      createdAt,
    });
    projectedScopes.set(scope.id, scope);
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: ordinal - 1 });
    yield* fileSystem.writeFileString(path.join(cwd, file), `${file}\n`);
    return yield* checkpoints.capture({
      scope,
      runId,
      nodeId,
      ordinalWithinScope: ordinal,
      appRunOrdinal: ordinal,
      capturedAt: createdAt,
    });
  });

  const turn1 = yield* runTurn(1, worktreeA, "turn-1.txt");
  const turn2 = yield* runTurn(2, worktreeB, "turn-2.txt");
  return { threadId, worktreeB, turn1, turn2, projectedScopes };
});

it.live("lists only turn 2's edit after the thread moves to another worktree of the repo", () =>
  Effect.gen(function* () {
    const { turn2 } = yield* runTurnsAcrossWorktrees;

    assert.deepEqual(
      turn2.files.map((file) => file.path),
      ["turn-2.txt"],
      "turn 2's checkpoint lists differences between worktree A's and worktree B's trees",
    );
  }).pipe(Effect.provide(layerGitCheckpoints)),
);

it.live("does not restore a checkpoint taken in another worktree into the thread's worktree", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const { threadId, worktreeB, turn1, projectedScopes } = yield* runTurnsAcrossWorktrees;
    const scope = projectedScopes.get(turn1.scopeId)!;

    // "Edit from here?" on turn 1 with "Revert files too", as CheckpointRollbackService runs it.
    const isolated = yield* isCheckpointRestoreIsolated(
      { id: threadId, worktreePath: worktreeB },
      scope,
      {
        fileSystem,
        path,
        projections: ProjectionStoreV2.of({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        } as unknown as ProjectionStoreV2["Service"]),
        projects: ProjectStoreV2.of({} as ProjectStoreV2["Service"]),
      },
    );
    const restored = isolated
      ? (yield* Effect.result(checkpoints.restore({ scope, checkpoint: turn1 })))._tag === "Success"
      : false;

    const worktreeBFiles = (yield* fileSystem.readDirectory(worktreeB))
      .filter((entry) => entry !== ".git")
      .toSorted();
    assert.deepEqual(
      { restored, worktreeBFiles },
      { restored, worktreeBFiles: ["b-only.txt", "shared.txt", "turn-2.txt"] },
      "restoring turn 1 wrote worktree A's tree into worktree B",
    );
  }).pipe(Effect.provide(layerGitCheckpoints)),
);
