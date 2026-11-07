import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
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
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect("gives each worktree its own path prefix, also when folder names match", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const worktree = (repository: string, worktreePath: string) => ({
      repository,
      repositoryPath: `/folder/${repository}`,
      worktreePath,
    });
    const prefixes = CheckpointService.repositoryPathPrefixes(path, [
      worktree("alpha", "/worktrees/one/shared"),
      worktree("alpha", "/worktrees/two/shared"),
      worktree("alpha", "/worktrees/shared-2"),
      worktree("beta", "/worktrees/beta/work"),
    ]);
    assert.deepEqual(
      [...prefixes.values()],
      ["alpha@shared", "alpha@shared-2", "alpha@shared-2-2", "beta"],
    );
    // Captured before prefixes were kept: both took `alpha`, and the first keeps it.
    const kept = CheckpointService.repositoryPathPrefixes(
      path,
      [worktree("alpha", "/worktrees/two/shared"), worktree("alpha", "/worktrees/one/shared")],
      [
        { ...worktree("alpha", "/worktrees/one/shared"), pathPrefix: "alpha" },
        { ...worktree("alpha", "/worktrees/two/shared"), pathPrefix: "alpha" },
      ],
    );
    assert.deepEqual([...kept.values()], ["alpha@shared", "alpha"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Turn 2 had no worktrees; turn 3 first attached beta, and its baseline sits
// at ordinal 2. Turn 2's checkpoint names that baseline.
it.effect.each([
  { stored: "marked backfilled", expected: { _tag: "found", ordinal: 2 } },
  { stored: "from before backfills were marked", expected: { _tag: "unavailable", ordinal: 1 } },
] as const)("rewinds beta to turn 1 past a borrowed entry $stored", ({ stored, expected }) => {
  const scopeId = CheckpointScopeId.make("checkpoint-scope:borrowed");
  const worktreePath = "/worktrees/beta/t3-thread";
  const entry = (ordinal: number) => ({
    repository: "beta",
    repositoryPath: "/folder/beta",
    worktreePath,
    branch: "t3/thread",
    pathPrefix: "beta",
    ref: CheckpointRef.make(`refs/t3/beta/ordinal/${ordinal}`),
    status: "ready" as const,
  });
  const history: CheckpointService.RepositoryCheckpointHistory = {
    scopeId,
    checkpoints: [
      { scopeId, ordinalWithinScope: 1, status: "ready", repositories: [] },
      {
        scopeId,
        ordinalWithinScope: 2,
        status: "ready",
        repositories: [
          stored === "marked backfilled" ? { ...entry(2), backfilled: true } : entry(2),
        ],
      },
      { scopeId, ordinalWithinScope: 3, status: "ready", repositories: [entry(3)] },
    ],
    runs: [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }],
  };
  return Effect.gen(function* () {
    const snapshot = yield* CheckpointService.resolveRepositorySnapshot({
      history,
      worktreePath,
      cwd: worktreePath,
      targetOrdinal: 1,
    });
    assert.deepEqual(
      snapshot._tag === "none" ? snapshot : { _tag: snapshot._tag, ordinal: snapshot.ordinal },
      expected,
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointStore.CheckpointStore)({
          // Only beta's attach baseline, at ordinal 2, exists.
          hasCheckpointRef: ({ checkpointRef }) =>
            Effect.succeed(checkpointRef.endsWith("/ordinal/2")),
        }),
        NodeCrypto.layer,
      ),
    ),
  );
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
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
          Layer.provideMerge(NodeServices.layer),
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
