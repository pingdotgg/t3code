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
















it.effect("bounds runtime provider-thread reads by ownership and preserves recovery liveness", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("ownership");
    const other = yield* createThread("other-owner");
    const ownerNodeId = NodeId.make("node:recovery:owner");
    yield* projections.apply({
      id: EventId.make("event:recovery:owner"),
      type: "node.updated",
      threadId,
      nodeId: ownerNodeId,
      driver,
      occurredAt: now,
      payload: {
        id: ownerNodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: ownerNodeId,
        kind: "root_turn",
        status: "completed",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: now,
      },
    });
    const cases = [
      { name: "direct", ownership: "direct", status: "active", ordinal: 2, included: true },
      { name: "owner", ownership: "owner", status: "active", ordinal: null, included: true },
      { name: "owner-only", ownership: "owner", status: "active", ordinal: 1, included: true },
      { name: "subagent", ownership: "subagent", status: "active", ordinal: 1, included: true },
      { name: "duplicate", ownership: "all", status: "active", ordinal: 1, included: true },
      { name: "roster", ownership: "direct", status: "idle", ordinal: 3, included: true },
      { name: "run", ownership: "owner", status: "idle", ordinal: 4, included: true },
      { name: "item", ownership: "subagent", status: "idle", ordinal: 5, included: true },
      { name: "waiting-run", ownership: "direct", status: "idle", ordinal: 6, included: true },
      { name: "settled", ownership: "all", status: "idle", ordinal: 7, included: false },
      { name: "unrelated", ownership: "none", status: "active", ordinal: 8, included: false },
      { name: "unrelated-run", ownership: "none", status: "idle", ordinal: 9, included: false },
    ] as const;
    for (const entry of cases) {
      const id = ProviderThreadId.make(`provider-thread:ownership:${entry.name}`);
      yield* projections.apply({
        id: EventId.make(`event:${id}`),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id,
          appThreadId:
            entry.name === "owner-only"
              ? null
              : entry.ownership === "direct" || entry.ownership === "all"
                ? threadId
                : other,
          ownerNodeId:
            entry.ownership === "owner" || entry.ownership === "all" ? ownerNodeId : null,
          driver,
          providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: entry.status,
          firstRunOrdinal: entry.ordinal,
          lastRunOrdinal: entry.ordinal,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          pendingBackgroundTasks:
            entry.name === "roster"
              ? [{ taskId: "shell", description: "background", kind: "command" }]
              : [],
        },
      });
      if (entry.ownership === "subagent" || entry.ownership === "all") {
        for (const suffix of ["a", "b"]) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_subagents
              (subagent_id, thread_id, parent_node_id, provider, provider_thread_id,
               origin, status, updated_at, payload_json)
            VALUES (${`${id}:${suffix}`}, ${threadId}, ${ownerNodeId}, 'codex', ${id},
              'provider_native', 'completed', '', '{}')
          `;
        }
      }
      if (entry.name === "run" || entry.name === "unrelated-run") {
        yield* createRun(threadId, "waiting", { ordinal: entry.ordinal, providerThreadId: id });
      }
    }
    const waitingProviderThreadId = ProviderThreadId.make("provider-thread:ownership:waiting-run");
    const waitingRunId = yield* createRun(threadId, "completed", {
      ordinal: 6,
      providerThreadId: waitingProviderThreadId,
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, ordinal, type,
         status, updated_at, payload_json)
      VALUES ('item:ownership', ${threadId}, ${waitingRunId}, ${ownerNodeId},
        ${ProviderThreadId.make("provider-thread:ownership:item")}, 1, 'assistant_message', 'waiting', '', '{}')
    `;
    const statements: Array<ReturnType<Statement.Statement<unknown>["compile"]>> = [];
    const observe: Statement.Transformer = (statement) => {
      const compiled = statement.compile();
      if (compiled[0].includes("SELECT provider_thread.payload_json")) statements.push(compiled);
      return Effect.succeed(statement);
    };
    const projection = yield* projections
      .getRuntimeRecoveryProjection(threadId)
      .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    assert.deepEqual(
      projection.providerThreads.map((row) => row.id),
      cases
        .filter((entry) => entry.included)
        .toSorted((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0) || a.name.localeCompare(b.name))
        .map((entry) => ProviderThreadId.make(`provider-thread:ownership:${entry.name}`)),
    );
    assert.equal(statements.length, 1);
    const [query, params] = statements[0]!;
    const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params);
    assert.isFalse(
      plan.some((row) => /^SCAN provider_thread(?:$| )/.test(row.detail)),
      JSON.stringify(plan),
    );
    assert.isTrue(
      plan.some((row) => row.detail.includes("provider_threads_owner_idx")),
      JSON.stringify(plan),
    );
    assert.isFalse(
      plan.some((row) => /SEARCH (owner|n) USING INDEX .*nodes_thread/.test(row.detail)),
      JSON.stringify(plan),
    );
  }).pipe(Effect.provide(layerTest)),
);

