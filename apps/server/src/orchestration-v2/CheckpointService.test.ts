import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

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

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        yield* CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(layerTest));
  },
);
