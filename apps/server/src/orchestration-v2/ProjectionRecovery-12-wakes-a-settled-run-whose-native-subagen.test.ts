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
















it.effect("wakes a settled run whose native subagent ran on its own provider thread", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("native-subagent");
    const parentProviderThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const childProviderThreadId = ProviderThreadId.make(`provider-thread:${threadId}:child`);
    const providerSessionId = ProviderSessionId.make(`session:${threadId}`);
    const subagentId = NodeId.make(`node:${threadId}:subagent`);
    // An older thread on the same Codex session is recovered first and stops it.
    const sibling = yield* createThread("a-shared-session");
    yield* createRun(sibling, "completed");
    for (const boundThreadId of [sibling, threadId]) {
      yield* projections.apply({
        id: EventId.make(`event:${boundThreadId}:session`),
        type: "provider-session.attached",
        threadId: boundThreadId,
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
    const settledRun = yield* createRun(threadId, "completed", {
      providerThreadId: parentProviderThreadId,
    });
    for (const [id, nativeId] of [
      [parentProviderThreadId, "native-thread"],
      [childProviderThreadId, "agent-thread"],
    ] as const) {
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
            id === parentProviderThreadId ? threadId : ThreadId.make(`${threadId}:child`),
          ownerNodeId: null,
          driver,
          providerInstanceId,
          providerSessionId,
          nativeThreadRef: { driver, nativeId, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: id === parentProviderThreadId ? 1 : null,
          lastRunOrdinal: id === parentProviderThreadId ? 1 : null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    const subagent = {
      threadId,
      runId: settledRun,
      origin: "provider_native",
      driver,
      providerInstanceId,
      childThreadId: null,
      prompt: "audit src",
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    } as const;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:subagent`),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...subagent,
        id: subagentId,
        parentNodeId: NodeId.make(`node:${threadId}:root`),
        createdBy: "agent",
        providerThreadId: childProviderThreadId,
        nativeTaskRef: { driver, nativeId: "call_1:agent-thread", strength: "strong" },
        title: null,
        model: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:subagent-item`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...subagent,
        id: TurnItemId.make(`item:${threadId}:subagent`),
        nodeId: subagentId,
        providerThreadId: childProviderThreadId,
        providerTurnId: null,
        nativeItemRef: { driver, nativeId: "call_1:agent-thread", strength: "strong" },
        parentItemId: null,
        ordinal: 1,
        type: "subagent",
        title: "audit",
        subagentId,
      },
    });

    yield* recovery.reconcile("startup");

    const effects = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
    `;
    assert.deepEqual(effects, [{ effect_id: `effect:restart-continuation:${settledRun}` }]);
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(projection.runs[0]?.restartCancelledBackgroundWork, [
      {
        kind: "subagent",
        label: "audit (id agent-thread)",
        id: TurnItemId.make(`item:${threadId}:subagent`),
      },
    ]);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

