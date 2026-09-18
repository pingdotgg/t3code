import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ProjectionStoreV2, layer, layerMemory } from "./ProjectionStore.ts";

const threadId = ThreadId.make("thread:checkpoint-reads");
const otherThreadId = ThreadId.make("thread:checkpoint-reads:other");
const providerThreadId = ProviderThreadId.make("provider-thread:checkpoint-reads");
const providerSessionId = ProviderSessionId.make("provider-session:checkpoint-reads");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test" };
const scopeId = CheckpointScopeId.make("scope:checkpoint-reads");
const otherScopeId = CheckpointScopeId.make("scope:checkpoint-reads:other");
const runId = (ordinal: number) => RunId.make(`run:checkpoint-reads:${ordinal}`);
const nodeId = (ordinal: number) => NodeId.make(`node:checkpoint-reads:${ordinal}`);
const attemptId = (ordinal: number) => RunAttemptId.make(`attempt:checkpoint-reads:${ordinal}`);
const turnId = (ordinal: number) => ProviderTurnId.make(`turn:checkpoint-reads:${ordinal}`);
const checkpointId = (ordinal: number) =>
  CheckpointId.make(`checkpoint:checkpoint-reads:${ordinal}`);

type EventInput<Event = OrchestrationV2DomainEvent> = Event extends OrchestrationV2DomainEvent
  ? Omit<Event, "id" | "occurredAt">
  : never;

const seed = Effect.gen(function* () {
  const store = yield* ProjectionStoreV2;
  const now = yield* DateTime.now;
  let sequence = 0;
  const apply = (event: EventInput) =>
    store.apply({
      ...event,
      id: EventId.make(`event:checkpoint-reads:${sequence++}`),
      occurredAt: now,
    } as OrchestrationV2DomainEvent);
  for (const id of [threadId, otherThreadId]) {
    yield* apply({
      type: "thread.created",
      threadId: id,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id,
        projectId: ProjectId.make("project:checkpoint-reads"),
        title: "Checkpoint reads",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/repo/worktree",
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
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
  }
  yield* apply({
    type: "provider-thread.updated",
    threadId,
    payload: {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 4,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* apply({
    type: "provider-session.attached",
    threadId,
    payload: {
      id: providerSessionId,
      driver,
      providerInstanceId,
      status: "ready",
      cwd: "/repo/worktree",
      model: "test",
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  for (const id of [scopeId, otherScopeId]) {
    yield* apply({
      type: "checkpoint-scope.created",
      threadId,
      payload: {
        id,
        threadId,
        runId: runId(1),
        nodeId: nodeId(1),
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/worktree",
        createdAt: now,
      },
    });
  }
  for (let ordinal = 1; ordinal <= 4; ordinal++) {
    const waiting = ordinal === 4;
    yield* apply({
      type: "run.created",
      threadId,
      payload: {
        id: runId(ordinal),
        threadId,
        ordinal,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message:checkpoint-reads:${ordinal}`),
        rootNodeId: nodeId(ordinal),
        activeAttemptId: attemptId(ordinal),
        status: waiting ? "waiting" : "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: waiting ? null : now,
        checkpointId: waiting ? null : checkpointId(ordinal),
        contextHandoffId: null,
      },
    });
    yield* apply({
      type: "run-attempt.created",
      threadId,
      runId: runId(ordinal),
      payload: {
        id: attemptId(ordinal),
        runId: runId(ordinal),
        attemptOrdinal: 1,
        rootNodeId: nodeId(ordinal),
        providerInstanceId,
        providerThreadId,
        providerTurnId: turnId(ordinal),
        reason: "initial",
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    });
    yield* apply({
      type: "node.updated",
      threadId,
      payload: {
        id: nodeId(ordinal),
        threadId,
        runId: runId(ordinal),
        parentNodeId: null,
        rootNodeId: nodeId(ordinal),
        kind: "root_turn",
        status: waiting ? "waiting" : "completed",
        countsForRun: true,
        providerThreadId,
        providerTurnId: turnId(ordinal),
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: scopeId,
        startedAt: now,
        completedAt: waiting ? null : now,
      },
    });
    yield* apply({
      type: "provider-turn.updated",
      threadId,
      payload: {
        id: turnId(ordinal),
        providerThreadId,
        nodeId: nodeId(ordinal),
        runAttemptId: attemptId(ordinal),
        nativeTurnRef: null,
        ordinal,
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    });
  }
  for (let ordinal = 0; ordinal <= 4; ordinal++) {
    yield* apply({
      type: "checkpoint.captured",
      threadId,
      payload: {
        id: checkpointId(ordinal),
        threadId,
        scopeId: ordinal === 4 ? otherScopeId : scopeId,
        runId: ordinal === 0 ? null : runId(ordinal),
        nodeId: nodeId(Math.max(1, ordinal)),
        parentCheckpointId: null,
        ordinalWithinScope: ordinal,
        appRunOrdinal: ordinal === 0 ? null : ordinal,
        ref: CheckpointRef.make(`refs/t3/read/${ordinal}`),
        status: ordinal === 3 ? "stale" : "ready",
        files: [],
        capturedAt: now,
      },
    });
  }
});

for (const [name, storeLayer] of [
  ["SQLite", layer.pipe(Layer.provideMerge(SqlitePersistenceMemory))],
  ["memory", layerMemory],
] as const) {
  it.layer(storeLayer)(`checkpoint projection reads (${name})`, (it) => {
    it.effect("selects capture readiness and rollback targets without unrelated history", () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* ProjectionStoreV2;
        const capture = yield* store.getCheckpointCaptureContext(threadId, {
          runId: runId(4),
          scopeId,
        });
        assert.deepEqual(
          capture.runs.map((run) => run.id),
          [runId(4)],
        );
        assert.deepEqual(
          capture.nodes.map((node) => node.id),
          [nodeId(4)],
        );
        assert.deepEqual(capture.checkpoints, [
          { scopeId, ordinalWithinScope: 0, status: "ready" },
          { scopeId, ordinalWithinScope: 3, status: "stale" },
        ]);
        const rollback = yield* store.getCheckpointRollbackContext(threadId, {
          providerThreadId,
          checkpointId: checkpointId(1),
          scopeId,
        });
        assert.deepEqual(
          rollback.runs.map((run) => run.id),
          [runId(1), runId(2), runId(3)],
        );
        assert.deepEqual(
          rollback.attempts.map((attempt) => attempt.id),
          [attemptId(1)],
        );
        assert.deepEqual(
          rollback.nodes.map((node) => node.id),
          [nodeId(2), nodeId(3)],
        );
        assert.deepEqual(
          rollback.checkpoints.map((checkpoint) => checkpoint.id),
          [checkpointId(1), checkpointId(2)],
        );
        assert.deepEqual(
          rollback.providerTurns.map((turn) => turn.id),
          [turnId(1), turnId(2), turnId(3), turnId(4)],
        );
        assert.deepEqual(
          rollback.providerSessions.map((session) => session.id),
          [providerSessionId],
        );
        const retry = yield* store.getCheckpointCaptureContext(threadId, {
          runId: runId(1),
          scopeId,
        });
        assert.deepEqual(retry.nodes, []);
        const foreign = yield* store.getCheckpointRollbackContext(otherThreadId, {
          providerThreadId,
          checkpointId: checkpointId(1),
          scopeId,
        });
        assert.deepEqual(foreign.providerThreads, []);
        assert.deepEqual(foreign.checkpoints, []);
        assert.deepEqual(foreign.runs, []);
      }),
    );
  });
}

it.effect("ignores obsolete transcript and unrelated checkpoint/run payloads in SQLite", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items (
    turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
    parent_item_id, ordinal, type, status, updated_at, payload_json
  ) VALUES ('obsolete', ${threadId}, NULL, NULL, NULL, NULL, NULL, 1, 'assistant_message', 'completed', '2026-09-17', '{"obsolete":true}')`;
    yield* sql`UPDATE orchestration_v2_projection_checkpoints
    SET payload_json = json_set(payload_json, '$.files', 'obsolete')
    WHERE checkpoint_id IN (${checkpointId(0)}, ${checkpointId(3)}, ${checkpointId(4)})`;
    // A waiting later run is not a completed run that rollback invalidates.
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{"obsolete":true}' WHERE run_id = ${runId(4)}`;
    assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
    const rollback = yield* store.getCheckpointRollbackContext(threadId, {
      providerThreadId,
      checkpointId: checkpointId(1),
      scopeId,
    });
    assert.deepEqual(
      rollback.checkpoints.map((checkpoint) => checkpoint.id),
      [checkpointId(1), checkpointId(2)],
    );
    // Capture readiness reads columns even when the prior file summaries are obsolete.
    yield* sql`UPDATE orchestration_v2_projection_runs
    SET status = 'waiting', payload_json = json_set(payload_json, '$.status', 'waiting', '$.checkpointId', NULL)
    WHERE run_id = ${runId(2)}`;
    const capture = yield* store.getCheckpointCaptureContext(threadId, {
      runId: runId(2),
      scopeId,
    });
    assert.deepEqual(
      capture.checkpoints.map((checkpoint) => checkpoint.ordinalWithinScope),
      [0, 1],
    );
  }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);
