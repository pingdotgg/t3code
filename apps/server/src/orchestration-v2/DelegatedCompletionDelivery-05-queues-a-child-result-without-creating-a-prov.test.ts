import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

import {
  driver,
  layerCheckpointStoreTest,
  layerPlatformTest,
  layerServerConfig,
  layerTest,
  layerTestProviderInstanceRegistry,
  layerVcsDriverRegistryTest,
  modelSelection,
  orchestrationAdapter,
  parentProviderThreadId,
  providerInstance,
  reconcileCommandId,
  runEvent,
  seedParentWithTerminalTask,
  seedRestartCancelledChild,
} from "./DelegatedCompletionDelivery-fixtures.testkit.ts";

it.layer(layerTest)("delegated tasks across a server restart", (it) => {
  it.effect("queues a child result without creating a provider history handoff", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:result-message-parent");
      const projectId = ProjectId.make("project:result-message");
      const runId = RunId.make("run:result-message-parent");
      const rootNodeId = NodeId.make("node:result-message-parent");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:result-message-seed"),
        deliveryState: "acknowledged",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "result-message-child",
        completionWake: "always",
        continuationPending: false,
        runStatus: "completed",
        now,
      });
      const parent = yield* orchestrator.getThreadProjection(threadId);
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      const providerThreadId = ProviderThreadId.make("provider-thread:result-message-child");
      yield* eventSink.write({
        commandId: CommandId.make("command:result-message-child-provider"),
        events: [
          {
            id: EventId.make("event:result-message-child-provider"),
            type: "provider-thread.updated",
            threadId: child.childThreadId,
            occurredAt: now,
            payload: {
              ...parent.providerThreads[0]!,
              id: providerThreadId,
              appThreadId: child.childThreadId,
            },
          },
          {
            id: EventId.make("event:result-message-child-run"),
            type: "run.updated",
            threadId: child.childThreadId,
            runId: child.childRunId,
            occurredAt: now,
            payload: { ...childProjection.runs[0]!, providerThreadId },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;
      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = recovered.subagents.find((candidate) => candidate.id === child.taskId)!;
      assert.equal(task.status, "completed");
      assert.isNotNull(task.result);
      assert.isEmpty(recovered.contextHandoffs);
      assert.equal(recovered.contextTransfers.length, 1);

      const delivery = recovered.runs.find((candidate) => candidate.id === runId)!
        .delegatedCompletion!.delivery!;
      const messageId = delivery.messageId;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:result-message-delivery"),
        threadId,
        messageId,
        text: "Delegated task finished.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: {
          parentRunId: runId,
          generation: delivery.generation,
          taskIds: [child.taskId],
        },
      });
      const queued = yield* orchestrator.getThreadProjection(threadId);
      assert.include(
        queued.messages.find((message) => message.id === messageId)?.text ?? "",
        task.result!,
      );
    }),
  );

  it.effect("holds a restart-cancelled child for its continuation's result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-parent");
      const projectId = ProjectId.make("project:restart-parent");
      const runId = RunId.make("run:restart-parent");
      const rootNodeId = NodeId.make("node:restart-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = (
        name: string,
        continuationPending: boolean,
        runStatus?: "cancelled" | "completed",
      ) =>
        seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name,
          completionWake: "always",
          continuationPending,
          ...(runStatus === undefined ? {} : { runStatus }),
          now,
        });
      const resumed = yield* child("restart-resumed-child", true);
      const stopped = yield* child("restart-stopped-child", false);
      const backgrounded = yield* child("restart-backgrounded-child", true, "completed");
      const recut = yield* child("restart-recut-child", false);
      const recutContinuationId = RunId.make("run:restart-recut-child:2");
      const recutCommandId = CommandId.make("command:restart-recut-child:reconcile");
      const recutRun = runEvent({
        threadId: recut.childThreadId,
        runId: recutContinuationId,
        ordinal: 2,
        status: "cancelled",
        now,
      });
      yield* eventSink.writeWithEffects({
        commandId: recutCommandId,
        events: [
          {
            ...recutRun,
            payload: {
              ...recutRun.payload,
              startedAt: null,
              restartContinuationOfRunId: recut.childRunId,
            },
          },
        ],
        effects: [
          {
            id: `effect:restart-continuation:${recutContinuationId}`,
            commandId: recutCommandId,
            threadId: recut.childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: recutContinuationId },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = (id: NodeId) => recovered.subagents.find((row) => row.id === id);
      assert.equal(task(stopped.taskId)?.status, "cancelled");
      assert.equal(task(stopped.taskId)?.completionDelivery?.state, "claimed");
      assert.equal(task(resumed.taskId)?.status, "running");
      assert.isNull(task(resumed.taskId)?.result ?? null);
      assert.equal(task(backgrounded.taskId)?.status, "running");
      assert.isNull(task(backgrounded.taskId)?.result ?? null);
      assert.equal(task(recut.taskId)?.status, "running");
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(recut.childThreadId));
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(resumed.childThreadId));
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      yield* orchestrator.recoverDelegatedTask(recut.childThreadId, recut.childRunId);
      const replayed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(replayed.subagents.find((row) => row.id === recut.taskId)?.status, "running");
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-stopped-child:resumed"),
        events: [
          runEvent({
            threadId: stopped.childThreadId,
            runId: RunId.make("run:restart-stopped-child:2"),
            ordinal: 2,
            status: "running",
            now,
          }),
        ],
      });
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      assert.isFalse(
        recovered.contextTransfers.some(
          (transfer) => transfer.sourceThreadId === resumed.childThreadId,
        ),
      );

      const afterSequence = yield* eventSink.latestSequence();
      const continuationRunId = RunId.make("run:restart-resumed-child:2");
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-resumed-child:completed"),
        events: [
          {
            id: EventId.make("event:restart-resumed-child:result"),
            type: "message.updated",
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            occurredAt: now,
            payload: {
              id: MessageId.make("message:restart-resumed-child:result"),
              threadId: resumed.childThreadId,
              runId: continuationRunId,
              nodeId: null,
              role: "assistant",
              text: "Finished after the restart.",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
            },
          },
          runEvent({
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            ordinal: 2,
            status: "completed",
            now,
          }),
        ],
      });
      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === resumed.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const finished = yield* orchestrator.getThreadProjection(threadId);
      const finishedTask = finished.subagents.find((row) => row.id === resumed.taskId);
      assert.equal(finishedTask?.status, "completed");
      assert.equal(finishedTask?.result, "Finished after the restart.");
    }),
  );

  it.effect("settles a restart-cancelled child whose continuation declines to start", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-declined-parent");
      const projectId = ProjectId.make("project:restart-declined-parent");
      const runId = RunId.make("run:restart-declined-parent");
      const rootNodeId = NodeId.make("node:restart-declined-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-declined-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-declined-child",
        completionWake: "always",
        continuationPending: true,
        now,
      });
      yield* orchestrator.recoverDelegatedTasks;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.subagents.find((row) => row.id === child.taskId)?.status, "running");

      yield* continueRestartedRun({
        threadId: child.childThreadId,
        sourceRunId: child.childRunId,
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
      );

      const settled = yield* orchestrator.getThreadProjection(threadId);
      const task = settled.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.equal(task?.completionDelivery?.state, "claimed");

      // The parent's Stop committed, but the restart cut the effect that stops its children.
      const stoppedChild = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-parent-stopped-child",
        completionWake: "always",
        continuationPending: true,
        now,
      });
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make("command:restart-declined-parent:stop"),
        events: [
          {
            id: EventId.make("event:restart-declined-parent:interrupt-request"),
            type: "turn-item.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("turn-item:restart-declined-parent:interrupt-request"),
              type: "run_interrupt_request",
              threadId,
              runId,
              nodeId: rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 90,
              status: "completed",
              title: "Interrupt requested",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              message: "Stopped by user",
            },
          },
        ],
      });
      yield* continueRestartedRun({
        threadId: stoppedChild.childThreadId,
        sourceRunId: stoppedChild.childRunId,
      }).pipe(Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })));
      const afterStop = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterStop.subagents.find((row) => row.id === stoppedChild.taskId)?.status,
        "cancelled",
      );
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(stoppedChild.childThreadId)).runs.map(
          (run) => run.id,
        ),
        [stoppedChild.childRunId],
      );
    }),
  );

  it.effect("reports a child whose monitor the restart cut as interrupted, not completed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-monitor-parent");
      const projectId = ProjectId.make("project:restart-monitor-parent");
      const runId = RunId.make("run:restart-monitor-parent");
      const rootNodeId = NodeId.make("node:restart-monitor-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-monitor-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-monitor-child",
        completionWake: "always",
        continuationPending: true,
        runStatus: "completed",
        lostWork: [{ kind: "monitor", label: "Gate attempt 9", awaited: true }],
        now,
      });
      yield* orchestrator.recoverDelegatedTasks;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.subagents.find((row) => row.id === child.taskId)?.status, "running");

      yield* continueRestartedRun({
        threadId: child.childThreadId,
        sourceRunId: child.childRunId,
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
      );

      const settled = yield* orchestrator.getThreadProjection(threadId);
      const task = settled.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "interrupted");
      assert.equal(task?.result, "Child task ended with status interrupted.");
      assert.equal(task?.completionDelivery?.state, "claimed");
    }),
  );

  it.effect("re-offers a cut delivery even when a continuation resumes its turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const seed = (name: string, continuationPending: boolean) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread:${name}`);
          const runId = RunId.make(`run:${name}`);
          const taskId = NodeId.make(`node:${name}-task`);
          const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
          const deliveryRunId = RunId.make(`run:${name}:delivery`);
          yield* seedParentWithTerminalTask({
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            runId,
            rootNodeId: NodeId.make(`node:${name}-root`),
            taskId,
            deliveryState: "claimed",
            completionWake: "always",
            deliveryTaskIds: [taskId],
            now,
          });
          yield* eventSink.writeWithEffects({
            commandId: reconcileCommandId(name),
            events: [
              {
                id: EventId.make(`event:${name}:delivery-message`),
                type: "message.updated",
                threadId,
                runId: deliveryRunId,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId: deliveryRunId,
                  nodeId: null,
                  role: "user",
                  text: `Delegated task ${taskId} reached a terminal state.`,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "server",
                  createdAt: now,
                  updatedAt: now,
                  delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
                },
              },
              runEvent({
                threadId,
                runId: deliveryRunId,
                ordinal: 2,
                status: "cancelled",
                now,
                providerThreadId: parentProviderThreadId(threadId),
                userMessageId: messageId,
              }),
            ],
            effects: continuationPending
              ? [
                  {
                    id: `effect:restart-continuation:${deliveryRunId}`,
                    commandId: reconcileCommandId(name),
                    threadId,
                    request: { type: "provider-runtime.continue", sourceRunId: deliveryRunId },
                  },
                ]
              : [],
          });
          return { threadId, runId, taskId };
        });
      const cut = yield* seed("delivery-cut", false);
      const resumed = yield* seed("delivery-resumed", true);

      yield* orchestrator.recoverDelegatedTasks;

      for (const seeded of [cut, resumed]) {
        const projection = yield* orchestrator.getThreadProjection(seeded.threadId);
        assert.deepEqual(
          projection.subagents.find((row) => row.id === seeded.taskId)?.completionDelivery?.state,
          "claimed",
        );
        const delivery = projection.runs.find((row) => row.id === seeded.runId)?.delegatedCompletion
          ?.delivery;
        assert.equal(delivery?.generation, 2);
        assert.deepEqual(delivery?.taskIds, [seeded.taskId]);
      }
    }),
  );

  it.effect("settles a cancelled child whose held wakes wait behind it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:held-wake-parent");
      const projectId = ProjectId.make("project:held-wake-parent");
      const runId = RunId.make("run:held-wake-parent");
      const rootNodeId = NodeId.make("node:held-wake-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:held-wake-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "held-wake-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      const held = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:held-wake-child:2"),
        ordinal: 2,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:held-wake-child:held"),
        events: [
          {
            ...held,
            payload: { ...held.payload, startedAt: null, completedAt: null, queueHeld: true },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = recovered.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.isNotNull(task?.result ?? null);
      assert.isTrue(
        recovered.contextTransfers.some(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourceThreadId === child.childThreadId,
        ),
      );
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(child.childThreadId));
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect("settles a child whose provider failure holds its queued wakes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:failed-hold-parent");
      const projectId = ProjectId.make("project:failed-hold-parent");
      const runId = RunId.make("run:failed-hold-parent");
      const rootNodeId = NodeId.make("node:failed-hold-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:failed-hold-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "failed-hold-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      const activeRun = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:2"),
        ordinal: 2,
        status: "running",
        now,
      });
      const queued = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:3"),
        ordinal: 3,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:resumed"),
        events: [
          activeRun,
          { ...queued, payload: { ...queued.payload, startedAt: null, completedAt: null } },
        ],
      });
      const afterSequence = yield* eventSink.latestSequence();
      const errorItemId = TurnItemId.make("turn-item:failed-hold-child:error");
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:failed"),
        events: [
          {
            id: EventId.make("event:failed-hold-child:error"),
            type: "turn-item.updated",
            threadId: child.childThreadId,
            runId: activeRun.runId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: errorItemId,
              type: "error",
              threadId: child.childThreadId,
              runId: activeRun.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "Provider failed.",
                code: "provider_failed",
                retryable: null,
              },
            },
          },
          {
            ...activeRun,
            id: EventId.make("event:failed-hold-child:failed"),
            payload: { ...activeRun.payload, status: "failed", completedAt: now },
          },
        ],
      });

      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" && stored.event.payload.id === child.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const recovered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(recovered.subagents.find((row) => row.id === child.taskId)?.status, "failed");
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["failed", false],
          ["queued", true],
        ],
      );
    }),
  );
});
