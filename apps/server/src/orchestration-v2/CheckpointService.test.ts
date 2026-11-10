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
import { checkpointRestoreRefusal } from "./CheckpointRestoreSafety.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect("fails stale ref cleanup when the repository probe fails", () => {
  const probeError = new VcsProcessTimeoutError({
    operation: "test.detect",
    command: "git",
    cwd: "/repo/a",
    timeoutMs: 30000,
  });
  const layerTest = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.fail(probeError),
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const result = yield* Effect.result(
      checkpoints.deleteStaleRefs({
        scope: {
          id: CheckpointScopeId.make("checkpoint-scope:probe-failure"),
          threadId: ThreadId.make("thread:probe-failure"),
          runId: RunId.make("run:probe-failure:1"),
          nodeId: NodeId.make("node:probe-failure:1"),
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo/a",
          createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
        },
        checkpoints: [],
        fallbackCwd: "/repo/b",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }).pipe(Effect.provide(layerTest));
});

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
              nodeId: scope.nodeId,
              capturedAt: scope.createdAt,
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
  Layer.provideMerge(IdAllocator.layer),
  Layer.provide(CheckpointStore.layer),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  Layer.provideMerge(layerVcsProcess),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-checkpoint-service-" }),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

// Turn 1 runs in worktree A, then the thread moves to worktree B (a branch with its own
// committed file) of the same repository, and turn 2 adds one file there. A legacy thread
// kept its one root scope across both, as threads did before root scopes were per workspace.
const runTurnsAcrossWorktrees = Effect.fn("runTurnsAcrossWorktrees")(function* (
  scopes: "per-workspace" | "legacy",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
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
    const prepared = yield* checkpoints.prepareRootRunScope({
      threadId,
      runId,
      rootNodeId: nodeId,
      providerThreadId,
      cwd,
      createdAt,
    });
    const scope =
      scopes === "legacy"
        ? { ...prepared, id: yield* CheckpointService.legacyRootScopeId(idAllocator, threadId) }
        : prepared;
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
  return { git, repo, threadId, worktreeA, worktreeB, turn1, turn2, projectedScopes, runTurn };
});

it.live("lists only turn 2's edit after the thread moves to another worktree of the repo", () =>
  Effect.gen(function* () {
    const { turn2 } = yield* runTurnsAcrossWorktrees("per-workspace");

    assert.deepEqual(
      turn2.files.map((file) => file.path),
      ["turn-2.txt"],
      "turn 2's checkpoint lists differences between worktree A's and worktree B's trees",
    );
  }).pipe(Effect.provide(layerGitCheckpoints)),
);

it.live("a worktree recreated after a rollback lists only its next turn's edit", () =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const { git, repo, worktreeA, worktreeB, turn2, projectedScopes, runTurn } =
      yield* runTurnsAcrossWorktrees("per-workspace");

    // Back in worktree A with B removed, a rollback to the thread start discards turn 2.
    yield* git(repo, "worktree", "remove", "--force", worktreeB);
    yield* checkpoints.deleteStaleRefs({
      scope: projectedScopes.get(turn2.scopeId)!,
      checkpoints: [turn2],
      fallbackCwd: worktreeA,
    });
    yield* git(repo, "worktree", "add", worktreeB, "branch-b");
    const turn3 = yield* runTurn(3, worktreeB, "turn-3.txt");

    assert.deepEqual(
      turn3.files.map((file) => file.path),
      ["turn-3.txt"],
    );
  }).pipe(Effect.provide(layerGitCheckpoints)),
);

it.live.each(["per-workspace", "legacy"] as const)(
  "does not restore a checkpoint taken in another worktree into the thread's worktree, %s scopes",
  (scopes) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const { threadId, worktreeB, turn1, projectedScopes } =
        yield* runTurnsAcrossWorktrees(scopes);
      const scope = projectedScopes.get(turn1.scopeId)!;

      // "Edit from here?" on turn 1 with "Revert files too", as CheckpointRollbackService runs it.
      const refusal = yield* checkpointRestoreRefusal(
        { id: threadId, worktreePath: worktreeB },
        scope,
        {
          fileSystem,
          path,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          projections: {
            getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
          } as never,
          projects: {} as never,
        },
      );
      if (refusal === null) yield* checkpoints.restore({ scope, checkpoint: turn1 });

      assert.deepEqual(
        (yield* fileSystem.readDirectory(worktreeB)).filter((entry) => entry !== ".git").toSorted(),
        ["b-only.txt", "shared.txt", "turn-2.txt"],
      );
      assert.strictEqual(refusal, scopes === "legacy" ? "legacy-checkpoint" : "other-workspace");
    }).pipe(Effect.provide(layerGitCheckpoints)),
);
