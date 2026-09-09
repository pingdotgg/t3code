import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CheckpointId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { checkpointRefForScopeOrdinal } from "./CheckpointService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
const projectionLayer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
  idAllocatorLayer,
);
it.effect("resolves the thread baseline after a second root run replaces scope ownership", () =>
  Effect.gen(function* () {
    const ids = yield* IdAllocatorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = DateTime.makeUnsafe("2026-09-08T12:00:00.000Z");
    const threadId = ThreadId.make("thread:audit-root-scope");
    const firstRunId = RunId.make("run:audit-root-scope:1");
    const secondRunId = RunId.make("run:audit-root-scope:2");
    const firstNodeId = NodeId.make("node:audit-root-scope:1");
    const secondNodeId = NodeId.make("node:audit-root-scope:2");
    const providerThreadId = ProviderThreadId.make("provider-thread:audit-root-scope");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const scopeId = yield* ids.allocate.checkpointScope({ threadId, name: "root" });
    const baselineId = CheckpointId.make("checkpoint:audit-root-scope:0");
    const firstCheckpointId = CheckpointId.make("checkpoint:audit-root-scope:1");
    const secondCheckpointId = CheckpointId.make("checkpoint:audit-root-scope:2");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" } as const;

    yield* projections.apply({
      id: EventId.make("event:audit-root-scope:thread"),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:audit-root-scope"),
        title: "Checkpoint scope probe",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });

    const applyRun = (input: {
      readonly runId: RunId;
      readonly nodeId: NodeId;
      readonly ordinal: number;
      readonly checkpointId: CheckpointId;
    }) =>
      projections.apply({
        id: EventId.make(`event:audit-root-scope:run:${input.ordinal}`),
        type: "run.updated",
        threadId,
        runId: input.runId,
        nodeId: input.nodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: input.runId,
          threadId,
          ordinal: input.ordinal,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:audit-root-scope:${input.ordinal}`),
          rootNodeId: input.nodeId,
          activeAttemptId: null,
          status: "completed" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: input.checkpointId,
          contextHandoffId: null,
        },
      });
    const applyScope = (runId: RunId, nodeId: NodeId, ordinal: number) =>
      projections.apply({
        id: EventId.make(`event:audit-root-scope:scope:${ordinal}`),
        type: "checkpoint-scope.created",
        threadId,
        runId,
        nodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId,
          runId,
          nodeId,
          parentScopeId: null,
          providerThreadId,
          kind: "root_run" as const,
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: ordinal === 1 ? "/repo" : "/prepared-repo",
          createdAt: now,
        },
      });
    const applyCheckpoint = (input: {
      readonly id: CheckpointId;
      readonly runId: RunId | null;
      readonly nodeId: NodeId;
      readonly ordinal: number;
      readonly appRunOrdinal: number | null;
    }) =>
      projections.apply({
        id: EventId.make(`event:audit-root-scope:checkpoint:${input.ordinal}`),
        type: "checkpoint.captured",
        threadId,
        ...(input.runId === null ? {} : { runId: input.runId }),
        nodeId: input.nodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: input.id,
          scopeId,
          threadId,
          runId: input.runId,
          nodeId: input.nodeId,
          parentCheckpointId:
            input.ordinal === 0 ? null : input.ordinal === 1 ? baselineId : firstCheckpointId,
          ordinalWithinScope: input.ordinal,
          appRunOrdinal: input.appRunOrdinal,
          ref: checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: input.ordinal }),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        },
      });

    yield* applyRun({
      runId: firstRunId,
      nodeId: firstNodeId,
      ordinal: 1,
      checkpointId: firstCheckpointId,
    });
    yield* applyScope(firstRunId, firstNodeId, 1);
    yield* applyCheckpoint({
      id: baselineId,
      runId: null,
      nodeId: firstNodeId,
      ordinal: 0,
      appRunOrdinal: null,
    });
    yield* applyCheckpoint({
      id: firstCheckpointId,
      runId: firstRunId,
      nodeId: firstNodeId,
      ordinal: 1,
      appRunOrdinal: 1,
    });
    yield* applyRun({
      runId: secondRunId,
      nodeId: secondNodeId,
      ordinal: 2,
      checkpointId: secondCheckpointId,
    });
    yield* applyScope(secondRunId, secondNodeId, 2);
    yield* applyCheckpoint({
      id: secondCheckpointId,
      runId: secondRunId,
      nodeId: secondNodeId,
      ordinal: 2,
      appRunOrdinal: 2,
    });

    const context = yield* projections.getCheckpointContext(threadId);
    assert.deepEqual(
      context.checkpoints.map((checkpoint) => checkpoint.appRunOrdinal),
      [null, 1, 2],
    );
    assert.equal(context.checkpointScopes.length, 1);
    assert.equal(context.checkpointScopes[0]?.runId, secondRunId);

    const queryLayer = CheckpointDiffQuery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCheckpointContext: () => Effect.succeed(context),
          }),
          Layer.mock(CheckpointStore.CheckpointStore)({
            diffCheckpoints: (input) => {
              assert.equal(input.cwd, "/prepared-repo");
              assert.equal(
                input.fromCheckpointRef,
                checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 0 }),
              );
              assert.equal(
                input.toCheckpointRef,
                checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 2 }),
              );
              return Effect.succeed("two-run diff");
            },
          }),
        ),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      return yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    }).pipe(Effect.provide(queryLayer));
    assert.equal(result.diff, "two-run diff");
  }).pipe(Effect.provide(projectionLayer)),
);
