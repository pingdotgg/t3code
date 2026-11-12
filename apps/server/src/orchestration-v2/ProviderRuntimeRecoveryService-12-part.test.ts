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
  "terminalizes the linked subagent and node for a stale subagent item on a settled run",
  () => {
    const threadId = ThreadId.make("thread_recovery_subagent");
    const settledRunId = RunId.make("run_recovery_subagent_settled");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_subagent");
    const staleSubagentNodeId = NodeId.make("node_recovery_subagent_stale");
    const doneSubagentNodeId = NodeId.make("node_recovery_subagent_done");
    const staleItemId = TurnItemId.make("turn_item_recovery_subagent_stale");
    const doneItemId = TurnItemId.make("turn_item_recovery_subagent_done");
    const claudeInstanceId = ProviderInstanceId.make("claude");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],

      runs: [{ id: settledRunId, status: "completed", providerInstanceId: claudeInstanceId }],
      attempts: [],
      nodes: [
        { id: staleSubagentNodeId, runId: settledRunId, status: "running" },
        { id: doneSubagentNodeId, runId: settledRunId, status: "completed" },
      ],
      subagents: [
        {
          id: staleSubagentNodeId,
          runId: settledRunId,
          origin: "provider_native",
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "running",
        },
        {
          id: doneSubagentNodeId,
          runId: settledRunId,
          origin: "provider_native",
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "completed",
          result: "done",
        },
      ],
      messages: [],
      turnItems: [
        {
          id: staleItemId,
          runId: settledRunId,
          nodeId: staleSubagentNodeId,
          providerThreadId,
          type: "subagent",
          status: "running",
          subagentId: staleSubagentNodeId,
          providerInstanceId: claudeInstanceId,
        },
        {
          id: doneItemId,
          runId: settledRunId,
          nodeId: doneSubagentNodeId,
          providerThreadId,
          type: "subagent",
          status: "completed",
          subagentId: doneSubagentNodeId,
          providerInstanceId: claudeInstanceId,
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
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      const events = committedInput?.events ?? [];

      const turnItemCancels = events.filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );
      assert.equal(turnItemCancels.length, 1);

      const subagentCancels = events.filter((event) => event.type === "subagent.updated");
      assert.equal(subagentCancels.length, 1);
      const subagentCancel = subagentCancels[0];
      assert.equal(
        subagentCancel?.type === "subagent.updated" ? subagentCancel.payload.id : null,
        staleSubagentNodeId,
      );
      assert.equal(
        subagentCancel?.type === "subagent.updated" ? subagentCancel.payload.status : null,
        "cancelled",
      );

      const nodeCancels = events.filter((event) => event.type === "node.updated");
      assert.equal(nodeCancels.length, 1);
      const nodeCancel = nodeCancels[0];
      assert.equal(
        nodeCancel?.type === "node.updated" ? nodeCancel.payload.id : null,
        staleSubagentNodeId,
      );

      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.id === doneSubagentNodeId,
        ),
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "node.updated" && event.payload.id === doneSubagentNodeId,
        ),
      );
    }).pipe(Effect.provide(layer));
  },
);

