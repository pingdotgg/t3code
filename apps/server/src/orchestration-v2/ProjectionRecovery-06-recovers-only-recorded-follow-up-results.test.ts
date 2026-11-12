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
















it.effect("recovers only recorded follow-up results with SQLite projections", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const parent = yield* createThread("followup-parent");
    const child = yield* createThread("followup-child", {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
      forkedFrom: { type: "node", nodeId: NodeId.make("node:original") },
    });
    const originalRunId = yield* createRun(child, "completed");
    yield* projections.apply({
      id: EventId.make("event:original-result"),
      type: "context-transfer.created",
      threadId: parent,
      occurredAt: now,
      payload: {
        id: ContextTransferId.make("transfer:original-result"),
        type: "subagent_result",
        sourceThreadId: child,
        targetThreadId: parent,
        sourcePoint: { threadId: child, runId: originalRunId },
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
    yield* createRun(child, "completed", { ordinal: 2 });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
    const taskId = NodeId.make("node:followup");
    yield* createRun(child, "completed", { ordinal: 3, delegatedTaskId: taskId });
    yield* createRun(child, "running", { ordinal: 4 });
    const task = {
      id: taskId,
      threadId: parent,
      runId: null,
      parentNodeId: NodeId.make("node:parent"),
      origin: "app_owned" as const,
      createdBy: "agent" as const,
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: child,
      nativeTaskRef: null,
      prompt: "Check the follow-up.",
      title: null,
      model: null,
      status: "running" as const,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    yield* projections.apply({
      id: EventId.make("event:followup-task"),
      type: "subagent.updated",
      threadId: parent,
      occurredAt: now,
      payload: task,
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), [child]);
    yield* projections.apply({
      id: EventId.make("event:followup-settled"),
      type: "subagent.updated",
      threadId: parent,
      occurredAt: now,
      payload: { ...task, status: "completed", result: "Follow-up result.", completedAt: now },
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
  }).pipe(Effect.provide(layerTest)),
);

