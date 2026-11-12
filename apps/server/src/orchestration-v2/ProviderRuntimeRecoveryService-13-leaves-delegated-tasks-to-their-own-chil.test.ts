import { assert, it, vi } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";















it.effect("leaves delegated tasks to their own child threads after process loss", () => {
  const threadId = ThreadId.make("thread_recovery_delegation");
  const settledRunId = RunId.make("run_recovery_delegation_settled");
  const runningRunId = RunId.make("run_recovery_delegation_running");
  const providerThreadId = ProviderThreadId.make("provider_thread_recovery_delegation");
  const claudeInstanceId = ProviderInstanceId.make("claude");
  const driver = ProviderDriverKind.make("claude");
  const settledTaskId = NodeId.make("node_recovery_delegation_settled");
  const runningTaskId = NodeId.make("node_recovery_delegation_running");
  const nativeSubagentId = NodeId.make("node_recovery_native_subagent");
  const delegatedTask = (id: NodeId, runId: RunId) => ({
    id,
    runId,
    origin: "app_owned",
    childThreadId: ThreadId.make(`thread:delegated-task:${id}`),
    driver,
    providerInstanceId: claudeInstanceId,
    status: "running",
  });
  const subagentItem = (subagentId: NodeId, runId: RunId, origin: string) => ({
    id: TurnItemId.make(`turn_item:${subagentId}`),
    runId,
    nodeId: subagentId,
    providerThreadId,
    type: "subagent",
    status: "running",
    subagentId,
    origin,
    childThreadId:
      origin === "app_owned" ? ThreadId.make(`thread:delegated-task:${subagentId}`) : null,
    providerInstanceId: claudeInstanceId,
    title: `subagent ${subagentId}`,
  });
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId, providerInstanceId: claudeInstanceId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [
      {
        id: providerThreadId,
        driver,
        providerInstanceId: claudeInstanceId,
        ownerNodeId: null,
        status: "idle",
        pendingBackgroundTasks: [],
      },
    ],
    providerTurns: [],
    runs: [
      {
        id: settledRunId,
        ordinal: 1,
        status: "completed",
        providerThreadId,
        providerInstanceId: claudeInstanceId,
      },
      {
        id: runningRunId,
        ordinal: 2,
        status: "running",
        providerThreadId,
        providerInstanceId: claudeInstanceId,
      },
    ],
    attempts: [],
    nodes: [
      { id: settledTaskId, runId: settledRunId, status: "running", kind: "subagent" },
      { id: runningTaskId, runId: runningRunId, status: "running", kind: "subagent" },
      { id: nativeSubagentId, runId: settledRunId, status: "running", kind: "subagent" },
    ],
    subagents: [
      delegatedTask(settledTaskId, settledRunId),
      delegatedTask(runningTaskId, runningRunId),
      {
        ...delegatedTask(nativeSubagentId, settledRunId),
        origin: "provider_native",
        childThreadId: null,
      },
    ],
    messages: [],
    turnItems: [
      subagentItem(settledTaskId, settledRunId, "app_owned"),
      subagentItem(runningTaskId, runningRunId, "app_owned"),
      subagentItem(nativeSubagentId, settledRunId, "provider_native"),
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    const events = committedInput?.events ?? [];
    const touched = events.flatMap((event) =>
      event.type === "turn-item.updated"
        ? event.payload.type === "subagent"
          ? [event.payload.subagentId]
          : []
        : event.type === "subagent.updated" || event.type === "node.updated"
          ? [event.payload.id]
          : [],
    );

    assert.isTrue(
      events.some(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === runningRunId &&
          event.payload.status === "cancelled",
      ),
    );
    assert.notInclude(touched, settledTaskId);
    assert.notInclude(touched, runningTaskId);
    assert.include(touched, nativeSubagentId);

    const noted = events.flatMap((event) =>
      event.type === "run.background-work-cancelled"
        ? event.payload.restartCancelledBackgroundWork.map((work) => work.label)
        : [],
    );
    assert.deepEqual(noted, [`subagent ${nativeSubagentId}`]);
  }).pipe(Effect.provide(layer));
});

