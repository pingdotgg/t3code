import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import delegatedRecoveryIndexes from "../persistence/Migrations/079_DelegatedRecoveryIndexes.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";

const layerTest = Layer.mergeAll(ProjectionStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerRecoveryTest = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(
    EventSink.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventStore.layer,
          ProjectionStore.layer,
          EffectOutbox.layer,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
  Layer.provide(ServerSettings.layerTest()),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:recovery:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:recovery"),
    title: name,
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
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* projections.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  overrides: Partial<OrchestrationV2Run> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const ordinal = overrides.ordinal ?? 1;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* projections.apply({
    id: EventId.make(`event:${runId}:created`),
    type: "run.created",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      checkpointId: null,
      contextHandoffId: null,
      ...overrides,
    },
  });
  return runId;
});
















it.effect("bounds streaming recovery reads by candidate runs and preserves message ordering", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("streaming");
    const other = yield* createThread("streaming-other");
    const empty = yield* createThread("streaming-empty");
    const statements: Array<ReturnType<Statement.Statement<unknown>["compile"]>> = [];
    const observe: Statement.Transformer = (statement) => {
      const compiled = statement.compile();
      if (compiled[0].includes("SELECT message.payload_json")) statements.push(compiled);
      return Effect.succeed(statement);
    };
    const expected: MessageId[] = [];
    const statuses = [
      "queued",
      "preparing",
      "starting",
      "running",
      "waiting",
      "completed",
      "interrupted",
      "rolled_back",
      "failed",
      "cancelled",
    ] as const;
    for (const [index, status] of statuses.entries()) {
      const runId = yield* createRun(threadId, status, { ordinal: index + 1 });
      for (const suffix of ["b", "a", "settled", "wrong-thread"]) {
        const id = MessageId.make(`message:streaming:${index}:${suffix}`);
        const streaming = suffix !== "settled";
        const messageThread = suffix === "wrong-thread" ? other : threadId;
        const createdAt = DateTime.add(now, { seconds: -index });
        yield* projections.apply({
          id: EventId.make(`event:${id}`),
          type: "message.updated",
          threadId: messageThread,
          runId,
          occurredAt: now,
          payload: {
            id,
            threadId: messageThread,
            runId,
            nodeId: null,
            role: "assistant",
            text: id,
            attachments: [],
            streaming,
            createdAt,
            updatedAt: now,
            createdBy: "agent",
            creationSource: "provider",
          },
        });
      }
      if (index < 5)
        expected.unshift(
          MessageId.make(`message:streaming:${index}:a`),
          MessageId.make(`message:streaming:${index}:b`),
        );
    }
    const foreignRun = yield* createRun(other, "running");
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('foreign-run', ${threadId}, ${foreignRun}, 'assistant', 1, '', '', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('old-history', ${empty}, NULL, 'assistant', 1, '', '', '{}')
    `;
    const projection = yield* projections
      .getRuntimeRecoveryProjection(threadId)
      .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    assert.deepEqual(
      projection.messages.map((message) => message.id),
      expected,
    );
    const emptyProjection = yield* projections
      .getRuntimeRecoveryProjection(empty)
      .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    assert.deepEqual(emptyProjection.messages, []);
    assert.equal(statements.length, 2);
    for (const [query, params] of statements) {
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params);
      assert.isTrue(plan[0]?.detail.includes("SEARCH run "), JSON.stringify(plan));
      assert.isTrue(
        plan.some((row) => row.detail.includes("messages_run_idx")),
        JSON.stringify(plan),
      );
      assert.isFalse(
        plan.some((row) => row.detail.includes("messages_thread_created_idx")),
        JSON.stringify(plan),
      );
    }
  }).pipe(Effect.provide(layerTest)),
);

