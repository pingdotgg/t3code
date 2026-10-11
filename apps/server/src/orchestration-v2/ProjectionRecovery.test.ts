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

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";

const layerTest = Layer.mergeAll(ProjectionStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
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
    const orphanSubagent = yield* createThread("orphan-native-subagent");
    for (const origin of ["provider_native", "app_owned"] as const) {
      const threadId =
        origin === "provider_native" ? orphanSubagent : yield* createThread("app-owned-subagent");
      const runId = yield* createRun(threadId, "completed");
      const nodeId = NodeId.make(`node:recovery:orphan:${origin}`);
      yield* projections.apply({
        id: EventId.make(`event:recovery:orphan:${origin}`),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId,
          parentNodeId: NodeId.make(`node:recovery:orphan-root:${origin}`),
          origin,
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId:
            origin === "app_owned" ? ThreadId.make("thread:recovery:delegated-child") : null,
          nativeTaskRef: null,
          prompt: "unfinished native work",
          title: null,
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
    }
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
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${queued} AND ordinal = 1
    `;
    assert.deepEqual(yield* projections.getRecoveryThreadIds("queued-runs"), [queued]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([queued, archived, blocked, background, outboxOnly, requestOnly, orphanSubagent]),
    );
    assert.deepEqual(yield* projections.getRecoveryThreadIds("delegated-completions"), [delivery]);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
    const recoveryState = yield* projections.getRuntimeRecoveryProjection(queued);
    const orphanState = yield* projections.getRuntimeRecoveryProjection(orphanSubagent);
    assert.equal(orphanState.subagents.length, 1);
    assert.equal(orphanState.runs[0]?.id, orphanState.subagents[0]?.runId);
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

it.effect.each(["startup", "shutdown"] as const)(
  "recovers native child turns and their runless streaming descendants on %s",
  (trigger) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = yield* createThread("native-child");
      const rootNodeId = NodeId.make("node:recovery:native-root");
      const textNodeId = NodeId.make("node:recovery:native-text");
      const providerThreadId = ProviderThreadId.make("provider-thread:recovery:native-child");
      const providerTurnId = ProviderTurnId.make("turn:recovery:native-child");
      yield* projections.apply({
        id: EventId.make("event:recovery:native-turn"),
        type: "provider-turn.updated",
        threadId,
        nodeId: rootNodeId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: rootNodeId,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), [threadId]);
      for (const [id, kind] of [
        [rootNodeId, "root_turn"],
        [textNodeId, "assistant_message"],
      ] as const) {
        yield* projections.apply({
          id: EventId.make(`event:${id}`),
          type: "node.updated",
          threadId,
          nodeId: id,
          occurredAt: now,
          payload: {
            id,
            threadId,
            runId: null,
            parentNodeId: id === rootNodeId ? null : rootNodeId,
            rootNodeId,
            kind,
            status: "running",
            countsForRun: false,
            providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
      }
      const itemId = TurnItemId.make("item:recovery:native-text");
      yield* projections.apply({
        id: EventId.make("event:recovery:native-text-item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: itemId,
          threadId,
          runId: null,
          nodeId: textNodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          type: "assistant_message",
          status: "running",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          messageId: MessageId.make("message:recovery:native-text"),
          text: "unfinished native child output",
          streaming: true,
        },
      });
      const recovered = yield* projections.getRuntimeRecoveryProjection(threadId);
      assert.deepEqual(
        recovered.providerTurns.map((turn) => turn.id),
        [providerTurnId],
      );
      assert.deepEqual(
        new Set(recovered.nodes.map((node) => node.id)),
        new Set([rootNodeId, textNodeId]),
      );
      assert.deepEqual(
        recovered.turnItems.map((item) => item.id),
        [itemId],
      );
      yield* ProviderRuntimeRecovery.make.pipe(
        Effect.flatMap((recovery) => recovery.reconcile(trigger)),
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) =>
                Effect.forEach(input.events, (event) => projections.apply(event), {
                  discard: true,
                }).pipe(
                  Effect.orDie,
                  Effect.as({ committed: true, cancelledEffectCount: 0 } as never),
                ),
            }),
            IdAllocator.layer,
            ServerSettings.layerTest(),
          ),
        ),
      );
      const after = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(
        after.providerTurns.map((turn) => turn.status),
        ["cancelled"],
      );
      assert.deepEqual(
        after.nodes.map((node) => node.status),
        ["cancelled", "cancelled"],
      );
      assert.equal(after.turnItems[0]?.status, "cancelled");
      assert.equal(
        after.turnItems[0]?.type === "assistant_message" && after.turnItems[0].streaming,
        false,
      );
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("recovers terminal subagent results until their cross-thread transfer exists", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const parent = yield* createThread("subagent-parent");
    const children: Array<ThreadId> = [];
    for (const name of ["terminal", "archived", "deleted", "running", "held", "queued"]) {
      const child = yield* createThread(`subagent-${name}`, {
        lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
        forkedFrom: { type: "node", nodeId: NodeId.make(`node:${name}`) },
        archivedAt: name === "archived" ? now : null,
        deletedAt: name === "deleted" ? now : null,
      });
      yield* createRun(child, name === "running" ? "running" : "completed");
      // A wake queued behind the result: held by Stop or a restart, or still deliverable.
      if (name === "held" || name === "queued") {
        yield* createRun(child, "queued", {
          ordinal: 2,
          startedAt: null,
          ...(name === "held" ? { queueHeld: true } : {}),
        });
      }
      children.push(child);
    }
    const terminalChildren = new Set([children[0]!, children[1]!, children[4]!]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("subagent-results")),
      terminalChildren,
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
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("subagent-results")),
      new Set([archivedChild, children[4]!]),
    );
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    yield* sql`
      UPDATE orchestration_v2_projection_context_transfers SET payload_json = '{}'
      WHERE context_transfer_id = ${transferId}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([parent, completed]),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("includes shared sessions and provider-owned background rosters in recovery", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
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
        pendingBackgroundTasks: [
          { taskId: "background", description: "Still running", kind: "command" },
        ],
      },
    });
    const prepared = yield* createThread("prepared-continuation");
    const preparedSessionId = ProviderSessionId.make("session:recovery:prepared");
    const preparedProviderThreadId = ProviderThreadId.make("provider-thread:recovery:prepared");
    yield* projections.apply({
      id: EventId.make("event:recovery:prepared-session"),
      type: "provider-session.attached",
      threadId: prepared,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: preparedSessionId,
        driver,
        providerInstanceId,
        status: "stopped",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:recovery:prepared-thread"),
      type: "provider-thread.updated",
      threadId: prepared,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: preparedProviderThreadId,
        appThreadId: prepared,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: preparedSessionId,
        nativeThreadRef: { driver, nativeId: "native:prepared", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [],
      },
    });
    const preparedRunId = yield* createRun(prepared, "starting", {
      providerThreadId: preparedProviderThreadId,
      restartContinuationOfRunId: RunId.make("run:recovery:source"),
    });
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([first, second, roster, prepared]),
    );
    const preparedState = yield* projections.getRuntimeRecoveryProjection(prepared);
    assert.deepEqual(
      preparedState.providerSessions.map((session) => session.id),
      [preparedSessionId],
    );
    assert.equal(restartContinuationRun(preparedState)?.id, preparedRunId);
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
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reads the run that owns a background roster, not a queued or resumed one", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const withRoster = Effect.fn(function* (threadId: ThreadId) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:roster`),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make(`provider-thread:${threadId}`),
          appThreadId: threadId,
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
          pendingBackgroundTasks: [
            { taskId: "background", description: "Still running", kind: "command" },
          ],
        },
      });
    });
    const runIds = (threadId: ThreadId) =>
      projections
        .getRuntimeRecoveryProjection(threadId)
        .pipe(Effect.map((state) => state.runs.map((run) => run.id)));
    // Settled with background work left, then a queued follow-up.
    const settled = yield* createThread("roster-before-queue");
    const settledRun = yield* createRun(settled, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${settled}`),
    });
    const queuedRun = yield* createRun(settled, "queued", { ordinal: 2, completedAt: null });
    yield* withRoster(settled);
    assert.deepEqual(yield* runIds(settled), [settledRun, queuedRun]);
    // A resumed queued run (ordinal 1) ended after a continuation (ordinal 2).
    const resumed = yield* createThread("roster-after-resume");
    const resumedRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z"),
    });
    const continuationRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      ordinal: 2,
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
    });
    yield* withRoster(resumed);
    assert.deepEqual(yield* runIds(resumed), [resumedRun, continuationRun]);
    // Without a roster, settled history is not read.
    const quiet = yield* createThread("no-roster-before-queue");
    yield* createRun(quiet, "completed");
    const quietQueued = yield* createRun(quiet, "queued", { ordinal: 2, completedAt: null });
    assert.deepEqual(yield* runIds(quiet), [quietQueued]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("marks fork descendants unreadable when their source is missing or corrupt", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
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
  }).pipe(Effect.provide(layerTest)),
);
