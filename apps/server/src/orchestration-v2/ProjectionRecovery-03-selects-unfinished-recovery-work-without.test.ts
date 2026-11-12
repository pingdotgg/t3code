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
















it.effect("selects unfinished recovery work without reading settled thread histories", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    for (let index = 0; index < 600; index += 1) {
      yield* createRun(yield* createThread(`settled-${index}`), "completed");
    }
    const queued = yield* createThread("queued");
    const archived = yield* createThread("archived", { archivedAt: now });
    const deleted = yield* createThread("deleted", { deletedAt: now });
    const blocked = yield* createThread("blocked");
    yield* createRun(queued, "completed");
    for (const threadId of [queued, archived, deleted, blocked]) {
      yield* createRun(threadId, "queued", threadId === queued ? { ordinal: 2 } : {});
    }
    yield* createRun(blocked, "waiting", { ordinal: 2 });
    const background = yield* createThread("background");
    yield* createRun(background, "completed");
    yield* projections.apply({
      id: EventId.make("event:recovery:background"),
      type: "turn-item.updated",
      threadId: background,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:recovery:background"),
        threadId: background,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "dynamic_tool",
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        toolName: "background",
        input: null,
        output: null,
      },
    });
    const outboxOnly = yield* createThread("outbox-only");
    yield* outbox.enqueue([
      {
        id: "effect:recovery:outbox-only",
        commandId: CommandId.make("command:recovery:outbox-only"),
        threadId: outboxOnly,
        request: { type: "provider-turn.start", runId: RunId.make("run:outbox-only") },
      },
    ]);
    const requestOnly = yield* createThread("request-only");
    yield* projections.apply({
      id: EventId.make("event:recovery:request-only"),
      type: "runtime-request.updated",
      threadId: requestOnly,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("request:recovery:pending"),
        nodeId: NodeId.make("node:recovery:request"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Process stopped" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const delivery = yield* createThread("delivery", { archivedAt: now });
    yield* createRun(delivery, "completed", {
      delegatedCompletion: {
        disposition: "open",
        nextGeneration: 2,
        delivery: { generation: 1, messageId: MessageId.make("message:delivery"), taskIds: [] },
      },
    });

    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${ThreadId.make("thread:recovery:settled-599")}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${queued} AND ordinal = 1
    `;
    assert.deepEqual(yield* projections.getRecoveryThreadIds("queued-runs"), [queued]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([queued, archived, blocked, background, outboxOnly, requestOnly]),
    );
    for (const [kind, expected, index] of [
      ["delegated-completions", [delivery], "runs_delegated_delivery_idx"],
      ["subagent-results", [], "threads_subagent_result_idx"],
    ] as const) {
      const statements: Array<ReturnType<Statement.Statement<unknown>["compile"]>> = [];
      const observe: Statement.Transformer = (statement) => {
        statements.push(statement.compile());
        return Effect.succeed(statement);
      };
      assert.deepEqual(
        yield* projections
          .getRecoveryThreadIds(kind)
          .pipe(Effect.provideService(Statement.CurrentTransformer, observe)),
        expected,
      );
      const [query, params] = statements[0]!;
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params);
      assert.isTrue(
        plan.some((row) => row.detail.includes(index)),
        JSON.stringify(plan),
      );
    }
    const recoveryState = yield* projections.getRuntimeRecoveryProjection(queued);
    assert.deepEqual(
      recoveryState.runs.map((run) => run.id),
      [RunId.make(`run:${queued}:2`)],
    );
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), [
      queued,
      ThreadId.make("thread:recovery:settled-599"),
    ]);
  }).pipe(Effect.provide(layerTest)),
);

