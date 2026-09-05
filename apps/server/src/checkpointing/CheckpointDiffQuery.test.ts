import { assert, it, vi } from "@effect/vitest";
import { CheckpointRef, CheckpointScopeId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import { checkpointStartRef } from "./Utils.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import {
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
} from "./Errors.ts";

const threadId = ThreadId.make("thread:checkpoint-diff-v2");
const firstRunId = RunId.make("run:checkpoint-diff-v2:1");
const secondRunId = RunId.make("run:checkpoint-diff-v2:2");
const firstScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:1");
const secondScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:2");
const secondRef = CheckpointRef.make("refs/t3/test/second");

function makeProjection(): ProjectionCheckpointContext {
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: firstRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" },
    ],
    checkpoints: [
      {
        scopeId: secondScopeId,
        runId: secondRunId,
        appRunOrdinal: 2,
        status: "ready",
        ref: secondRef,
      },
    ],
  };
}

function makeLayer(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly hasStartSnapshot?: boolean;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
}) {
  return CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () => input.projection,
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          hasCheckpointRef: () => Effect.succeed(input.hasStartSnapshot ?? false),
          diffCheckpoints: input.diffCheckpoints ?? (() => Effect.succeed("diff")),
        }),
      ),
    ),
  );
}

it.effect("computes V2 run diffs from projected checkpoint scopes", () => {
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("diff --git a/file b/file"),
  );
  const layer = makeLayer({
    projection: Effect.succeed(makeProjection()),
    diffCheckpoints,
    hasStartSnapshot: true,
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });

    assert.deepEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: "diff --git a/file b/file",
    });
    assert.deepEqual(diffCheckpoints.mock.calls[0]?.[0], {
      cwd: "/repo",
      fromCheckpointRef: checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      }),
      toCheckpointRef: secondRef,
      fallbackFromToHead: false,
      ignoreWhitespace: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-thread error contract", () => {
  const layer = makeLayer({
    projection: Effect.fail(new OrchestratorProjectionError({ threadId })),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointThreadNotFoundError);
    assert.deepEqual(
      { operation: error.operation, threadId: error.threadId },
      { operation: "CheckpointDiffQuery.getTurnDiff", threadId },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed unavailable-range error contract", () => {
  const layer = makeLayer({ projection: Effect.succeed(makeProjection()) });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 3 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 3, availableTurnCount: 2 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("excludes ready checkpoints from rolled-back runs", () => {
  const projection = makeProjection();
  const layer = makeLayer({
    projection: Effect.succeed({
      ...projection,
      runs: projection.runs.map((run) =>
        run.id === secondRunId ? { ...run, status: "rolled_back" as const } : run,
      ),
      checkpoints: [
        {
          ...projection.checkpoints[0]!,
          scopeId: firstScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/t3/test/first"),
        },
        ...projection.checkpoints,
      ],
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 2, availableTurnCount: 1 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-baseline-ref error contract", () => {
  const projection = makeProjection();
  const layer = makeLayer({
    projection: Effect.succeed({
      ...projection,
      checkpointScopes: projection.checkpointScopes.filter((scope) => scope.id !== firstScopeId),
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointRefUnavailableError);
    assert.deepEqual(
      { checkpoint: error.checkpoint, turnCount: error.turnCount },
      { checkpoint: "from", turnCount: 0 },
    );
  }).pipe(Effect.provide(layer));
});

for (const hasStartSnapshot of [false, true]) {
  it.effect(
    `uses ${hasStartSnapshot ? "fresh" : "legacy"} baseline for an individual V2 turn`,
    () => {
      const projection = makeProjection();
      const firstRef = checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 1,
      });
      const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
        Effect.succeed("patch"),
      );
      const layer = makeLayer({
        hasStartSnapshot,
        diffCheckpoints,
        projection: Effect.succeed({
          ...projection,
          checkpoints: [
            ...projection.checkpoints,
            {
              scopeId: firstScopeId,
              runId: firstRunId,
              appRunOrdinal: 1,
              status: "ready",
              ref: firstRef,
            },
          ],
        }),
      });
      return Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        yield* query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 });
        assert.equal(
          diffCheckpoints.mock.calls[0]?.[0].fromCheckpointRef,
          hasStartSnapshot ? checkpointStartRef(secondRef) : firstRef,
        );
      }).pipe(Effect.provide(layer));
    },
  );
}
