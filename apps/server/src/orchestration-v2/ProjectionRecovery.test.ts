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
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EffectOutboxV2, layer as effectOutboxLayer } from "./EffectOutbox.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";

const TestLayer = Layer.mergeAll(projectionStoreLayer, effectOutboxLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const projections = yield* ProjectionStoreV2;
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
  const projections = yield* ProjectionStoreV2;
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
    const projections = yield* ProjectionStoreV2;
    const outbox = yield* EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    for (let index = 0; index < 600; index += 1) {
      yield* createRun(yield* createThread(`settled-${index}`), "completed");
    }
    const queued = yield* createThread("queued");
    const archived = yield* createThread("archived", { archivedAt: now });
    const deleted = yield* createThread("deleted", { deletedAt: now });
    const blocked = yield* createThread("blocked");
    for (const threadId of [queued, archived, deleted, blocked]) {
      yield* createRun(threadId, "queued");
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

    // This historical payload cannot be decoded. Candidate discovery must not
    // materialize it while deciding which threads have work to reconcile.
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${ThreadId.make("thread:recovery:settled-599")}
    `;
    assert.deepEqual(yield* projections.getRecoveryThreadIds("queued-runs"), [queued]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([queued, archived, blocked, background, outboxOnly, requestOnly]),
    );
    assert.deepEqual(yield* projections.getRecoveryThreadIds("delegated-completions"), [delivery]);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), [
      ThreadId.make("thread:recovery:settled-599"),
    ]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("recovers terminal subagent results until their cross-thread transfer exists", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const parent = yield* createThread("subagent-parent");
    const children: Array<ThreadId> = [];
    for (const name of ["terminal", "archived", "deleted", "running"]) {
      const child = yield* createThread(`subagent-${name}`, {
        lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
        forkedFrom: { type: "node", nodeId: NodeId.make(`node:${name}`) },
        archivedAt: name === "archived" ? now : null,
        deletedAt: name === "deleted" ? now : null,
      });
      yield* createRun(child, name === "running" ? "running" : "completed");
      children.push(child);
    }
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("subagent-results")),
      new Set(children.slice(0, 2)),
    );
    const completed = children[0]!;
    const transferId = ContextTransferId.make("transfer:recovery:subagent-result");
    yield* projections.apply({
      id: EventId.make("event:recovery:subagent-result"),
      type: "context-transfer.created",
      threadId: parent,
      occurredAt: now,
      payload: {
        id: transferId,
        type: "subagent_result",
        sourceThreadId: completed,
        targetThreadId: parent,
        sourcePoint: { threadId: completed },
        basePoint: null,
        sourceProviderInstanceId: providerInstanceId,
        targetProviderInstanceId: providerInstanceId,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      },
    });
    const archivedChild = children[1];
    assert.isDefined(archivedChild);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), [archivedChild]);
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    yield* sql`
      UPDATE orchestration_v2_projection_context_transfers SET payload_json = '{}'
      WHERE context_transfer_id = ${transferId}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([parent, completed]),
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("includes shared sessions and provider-owned background rosters in recovery", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const now = yield* DateTime.now;
    const first = yield* createThread("shared-first");
    const second = yield* createThread("shared-second", { archivedAt: now });
    const providerSessionId = ProviderSessionId.make("session:recovery:shared");
    for (const threadId of [first, second]) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:session`),
        type: "provider-session.attached",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
    }
    const roster = yield* createThread("roster");
    yield* projections.apply({
      id: EventId.make("event:recovery:roster"),
      type: "provider-thread.updated",
      threadId: roster,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make("provider-thread:recovery:roster"),
        appThreadId: roster,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [{ taskId: "background", description: "Still running" }],
      },
    });
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([first, second, roster]),
    );
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE orchestration_v2_projection_provider_sessions SET payload_json = '{}'
      WHERE provider_session_id = ${providerSessionId}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([first, second]),
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("marks fork descendants unreadable when their source is missing or corrupt", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const source = yield* createThread("source");
    const sourceRun = yield* createRun(source, "completed");
    const fork = yield* createThread("fork", {
      forkedFrom: { type: "run", threadId: source, runId: sourceRun },
    });
    const descendant = yield* createThread("descendant", {
      forkedFrom: { type: "run", threadId: fork, runId: RunId.make("run:fork") },
    });
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{}'
      WHERE run_id = ${sourceRun}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([source, fork, descendant]),
    );
    yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${source}`;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([fork, descendant]),
    );
  }).pipe(Effect.provide(TestLayer)),
);
