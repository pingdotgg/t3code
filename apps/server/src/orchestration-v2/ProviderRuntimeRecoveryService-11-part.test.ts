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















it.effect(
  "terminalizes a leftover nonpersistent dynamic_tool on a settled run after process loss",
  () => {
    const threadId = ThreadId.make("thread_recovery_orphan_wait");
    const settledRunId = RunId.make("run_recovery_orphan_wait_settled");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_orphan_wait");
    const orphanWaitItemId = TurnItemId.make(
      "turn-item:provider:codex:native-item:exec-4669f3bb-78c9-4af1-b44e-daa340d2c538",
    );
    const persistentMonitorItemId = TurnItemId.make(
      "turn-item:provider:codex:native-item:exec-persistent-monitor",
    );
    const orphanWaitNodeId = NodeId.make("node_recovery_orphan_wait");
    const persistentMonitorNodeId = NodeId.make("node_recovery_persistent_monitor");
    const codexInstanceId = ProviderInstanceId.make("codex");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId, providerInstanceId: codexInstanceId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],
      runs: [{ id: settledRunId, status: "completed", providerInstanceId: codexInstanceId }],
      attempts: [],
      nodes: [
        { id: orphanWaitNodeId, runId: settledRunId, status: "running", kind: "tool_call" },
        {
          id: persistentMonitorNodeId,
          runId: settledRunId,
          status: "running",
          kind: "tool_call",
        },
      ],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: orphanWaitItemId,
          runId: settledRunId,
          nodeId: orphanWaitNodeId,
          providerThreadId,
          type: "dynamic_tool",
          status: "running",
          toolName: "t3-code.t3_thread_wait",
          input: {
            threadId:
              "thread:delegated-task:command%3Amcp%3Aaafffab1-e811-458a-ae83-558e542c61ff%3Adelegate-task%3Areview-mobile-reconnect-opus-20260815",
            timeoutMs: 30000,
          },
        },
        {
          id: persistentMonitorItemId,
          runId: settledRunId,
          nodeId: persistentMonitorNodeId,
          providerThreadId,
          type: "dynamic_tool",
          status: "running",
          toolName: "grok.monitor",
          input: { persistent: true, command: "tail -f" },
        },
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
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 0);
      const turnItemCancels = (committedInput?.events ?? []).filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );

      assert.equal(turnItemCancels.length, 2);
      assert.deepEqual(
        turnItemCancels
          .map((event) => event.type === "turn-item.updated" && event.payload.id)
          .sort(),
        [orphanWaitItemId, persistentMonitorItemId].sort(),
      );
      const nodeCancels = (committedInput?.events ?? []).filter(
        (event) => event.type === "node.updated" && event.payload.status === "cancelled",
      );
      assert.equal(nodeCancels.length, 2);
      assert.deepEqual(
        nodeCancels.map((event) => event.type === "node.updated" && event.payload.id).sort(),
        [orphanWaitNodeId, persistentMonitorNodeId].sort(),
      );
    }).pipe(Effect.provide(layer));
  },
);

