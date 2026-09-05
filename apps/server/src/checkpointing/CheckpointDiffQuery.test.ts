import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import {
  applyToProjection,
  emptyProjection,
  type ProjectionCheckpointContext,
} from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
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
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeProjection(): ProjectionCheckpointContext {
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "completed" },
    ],
    checkpointScopes: [{ id: firstScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" }],
    checkpoints: [
      {
        scopeId: firstScopeId,
        runId: secondRunId,
        appRunOrdinal: 2,
        status: "ready",
        ref: secondRef,
      },
    ],
  };
}

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: "Checkpoint diff",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function threadCreatedEvent(
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
): Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }> {
  return {
    id: EventId.make(`event:create:${thread.id}`),
    type: "thread.created",
    threadId: thread.id,
    providerInstanceId,
    occurredAt: now,
    payload: thread,
  };
}

function makeLayer(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
}) {
  return CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () => input.projection,
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          diffCheckpoints: input.diffCheckpoints ?? (() => Effect.succeed("diff")),
        }),
      ),
    ),
  );
}

it.effect("uses the reused root scope as the full-thread baseline after two runs", () =>
  Effect.gen(function* () {
    const ids = yield* IdAllocatorV2;
    const now = DateTime.makeUnsafe("2026-09-05T00:00:00.000Z");
    const sharedScopeId = yield* ids.allocate.checkpointScope({ threadId, name: "root" });
    const reusedScopeId = yield* ids.allocate.checkpointScope({ threadId, name: "root" });
    const providerThreadId = ProviderThreadId.make("provider-thread:checkpoint-diff-v2");
    const firstNodeId = NodeId.make("node:checkpoint-diff-v2:1");
    const secondNodeId = NodeId.make("node:checkpoint-diff-v2:2");
    const firstCheckpointId = CheckpointId.make("checkpoint:checkpoint-diff-v2:1");
    const secondCheckpointId = CheckpointId.make("checkpoint:checkpoint-diff-v2:2");
    const firstRef = CheckpointRef.make("refs/t3/test/first");
    let projection = emptyProjection(threadCreatedEvent(makeThread(threadId, now), now));

    const runEvent = (
      runId: RunId,
      ordinal: number,
      nodeId: NodeId,
      checkpointId: CheckpointId,
    ): Extract<OrchestrationV2DomainEvent, { readonly type: "run.created" }> => ({
      id: EventId.make(`event:run:${ordinal}`),
      type: "run.created",
      threadId,
      runId,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message:checkpoint-diff-v2:${ordinal}`),
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId,
        contextHandoffId: null,
      },
    });
    const scopeEvent = (
      eventId: EventId,
      runId: RunId,
      nodeId: NodeId,
    ): Extract<OrchestrationV2DomainEvent, { readonly type: "checkpoint-scope.created" }> => ({
      id: eventId,
      type: "checkpoint-scope.created",
      threadId,
      runId,
      nodeId,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: sharedScopeId,
        threadId,
        runId,
        nodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo",
        createdAt: now,
      },
    });
    const checkpointEvent = (
      checkpointId: CheckpointId,
      runId: RunId,
      nodeId: NodeId,
      ordinal: number,
      ref: CheckpointRef,
    ): Extract<OrchestrationV2DomainEvent, { readonly type: "checkpoint.captured" }> => ({
      id: EventId.make(`event:checkpoint:${ordinal}`),
      type: "checkpoint.captured",
      threadId,
      runId,
      nodeId,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: checkpointId,
        threadId,
        scopeId: sharedScopeId,
        runId,
        nodeId,
        parentCheckpointId: null,
        ordinalWithinScope: ordinal,
        appRunOrdinal: ordinal,
        ref,
        status: "ready",
        files: [],
        capturedAt: now,
      },
    });

    for (const event of [
      runEvent(firstRunId, 1, firstNodeId, firstCheckpointId),
      scopeEvent(EventId.make("event:scope:1"), firstRunId, firstNodeId),
      checkpointEvent(firstCheckpointId, firstRunId, firstNodeId, 1, firstRef),
      runEvent(secondRunId, 2, secondNodeId, secondCheckpointId),
      scopeEvent(EventId.make("event:scope:2"), secondRunId, secondNodeId),
      checkpointEvent(secondCheckpointId, secondRunId, secondNodeId, 2, secondRef),
    ]) {
      projection = applyToProjection(projection, event);
    }

    assert.equal(sharedScopeId, reusedScopeId);
    assert.deepEqual(
      projection.checkpointScopes.map(({ id, runId }) => ({ id, runId })),
      [{ id: sharedScopeId, runId: secondRunId }],
    );

    const context: ProjectionCheckpointContext = {
      runs: projection.runs.map(({ id, ordinal, status }) => ({ id, ordinal, status })),
      checkpointScopes: projection.checkpointScopes.map(({ id, runId, kind, cwd }) => ({
        id,
        runId,
        kind,
        cwd,
      })),
      checkpoints: projection.checkpoints.map(({ scopeId, runId, appRunOrdinal, status, ref }) => ({
        scopeId,
        runId,
        appRunOrdinal,
        status,
        ref,
      })),
    };
    const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
      Effect.succeed("diff --git a/file b/file"),
    );
    const result = yield* Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      return yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    }).pipe(Effect.provide(makeLayer({ projection: Effect.succeed(context), diffCheckpoints })));

    assert.deepEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: "diff --git a/file b/file",
    });
    assert.deepEqual(diffCheckpoints.mock.calls[0]?.[0], {
      cwd: "/repo",
      fromCheckpointRef: checkpointRefForScopeOrdinal({
        scopeId: sharedScopeId,
        ordinalWithinScope: 0,
      }),
      toCheckpointRef: secondRef,
      fallbackFromToHead: false,
      ignoreWhitespace: true,
    });
  }).pipe(Effect.provide(idAllocatorLayer)),
);

it.effect("keeps a nonzero baseline in the target checkpoint scope", () => {
  const projection = makeProjection();
  const targetFirstRef = CheckpointRef.make("refs/t3/test/target-first");
  const unrelatedFirstRef = CheckpointRef.make("refs/t3/test/unrelated-first");
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("diff"),
  );
  const layer = makeLayer({
    projection: Effect.succeed({
      ...projection,
      checkpointScopes: [
        ...projection.checkpointScopes,
        { id: secondScopeId, runId: firstRunId, kind: "root_run", cwd: "/other-repo" },
      ],
      checkpoints: [
        {
          scopeId: secondScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          status: "ready",
          ref: unrelatedFirstRef,
        },
        {
          scopeId: firstScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          status: "ready",
          ref: targetFirstRef,
        },
        ...projection.checkpoints,
      ],
    }),
    diffCheckpoints,
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    yield* query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 });

    assert.deepEqual(diffCheckpoints.mock.calls[0]?.[0], {
      cwd: "/repo",
      fromCheckpointRef: targetFirstRef,
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
  const layer = makeLayer({ projection: Effect.succeed(projection) });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointRefUnavailableError);
    assert.deepEqual(
      { checkpoint: error.checkpoint, turnCount: error.turnCount },
      { checkpoint: "from", turnCount: 1 },
    );
  }).pipe(Effect.provide(layer));
});
