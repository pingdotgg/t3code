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

it.layer(layerTest)("delegated completion delivery repairs", (it) => {
  it.effect(
    "treats repeated acknowledge and dispose with distinct command IDs as successful no-ops",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:delegated-delivery-a2");
        const projectId = ProjectId.make("project:delegated-delivery-a2");
        const runId = RunId.make("run:delegated-delivery-a2");
        const rootNodeId = NodeId.make("node:delegated-delivery-a2-root");
        const taskId = NodeId.make("node:delegated-delivery-a2-task");

        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId,
          deliveryState: "delivered",
          completionWake: "always",
          now,
        });

        const firstAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-task-status"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const secondAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-thread-read"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });

        const firstAckTask = firstAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondAckTask = secondAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstAckTask);
        assert.isDefined(secondAckTask);
        if (
          firstAckTask?.event.type !== "subagent.updated" ||
          secondAckTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Acknowledge events missing."));
        }
        assert.equal(firstAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.equal(secondAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.deepEqual(
          secondAckTask.event.payload.completionDelivery,
          firstAckTask.event.payload.completionDelivery,
        );
        assert.deepEqual(
          secondAckTask.event.payload.updatedAt,
          firstAckTask.event.payload.updatedAt,
        );
        assert.equal(secondAck.storedEvents.length, 1);

        const afterAck = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterAck.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "acknowledged",
            observedByRunId: runId,
          },
        );

        const firstDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-task-status"),
          parentThreadId: threadId,
          taskId,
        });
        const secondDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-thread-read"),
          parentThreadId: threadId,
          taskId,
        });

        const firstDisposeTask = firstDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondDisposeTask = secondDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstDisposeTask);
        assert.isDefined(secondDisposeTask);
        if (
          firstDisposeTask?.event.type !== "subagent.updated" ||
          secondDisposeTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Dispose events missing."));
        }
        assert.equal(firstDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.equal(secondDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.deepEqual(
          secondDisposeTask.event.payload.completionDelivery,
          firstDisposeTask.event.payload.completionDelivery,
        );
        assert.equal(secondDispose.storedEvents.length, 1);

        const afterDispose = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterDispose.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );

        const acknowledgeAfterDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-after-dispose"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const acknowledgedTask = acknowledgeAfterDispose.storedEvents.find(
          (stored) => stored.event.type === "subagent.updated",
        );
        if (acknowledgedTask?.event.type !== "subagent.updated") {
          return yield* Effect.die(new Error("Acknowledge-after-dispose event missing."));
        }
        assert.deepEqual(acknowledgedTask.event.payload.completionDelivery, {
          state: "disposed",
          observedByRunId: null,
        });
        assert.equal(acknowledgeAfterDispose.storedEvents.length, 1);

        const afterStaleAcknowledge = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterStaleAcknowledge.subagents.find((candidate) => candidate.id === taskId)
            ?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );
      }),
  );

  it.effect.each([
    { command: "acknowledge", before: "running", after: "failed", capture: false },
    { command: "acknowledge", before: "waiting", after: "completed", capture: true },
    { command: "accept", before: "waiting", after: "completed", capture: true },
    { command: "wake-policy", before: "running", after: "completed", capture: true },
  ] as const)(
    "keeps a $after run that settled between $command's read and commit",
    ({ command, before, after, capture }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const race = `${command}-settle-race-${after}`;
        const threadId = ThreadId.make(`thread:${race}`);
        const runId = RunId.make(`run:${race}`);
        const taskId = NodeId.make(`node:${race}-task`);
        const checkpointId = CheckpointId.make(`checkpoint:${race}`);
        const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
        const commandType = {
          acknowledge: "delegated_task.completion-delivery.acknowledge",
          accept: "notification.delivery.accept",
          "wake-policy": "delegated_task.wake-policy",
        }[command];
        yield* seedParentWithTerminalTask({
          threadId,
          projectId: ProjectId.make(`project:${race}`),
          runId,
          rootNodeId: NodeId.make(`node:${race}-root`),
          taskId,
          ...(command === "wake-policy"
            ? { deliveryState: "pending" }
            : { deliveryState: "claimed", deliveryTaskIds: [taskId] }),
          now,
        });
        const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${race}-before`),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: { ...parent, status: before },
            },
            {
              id: EventId.make(`event:${race}-message`),
              type: "message.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: messageId,
                threadId,
                runId,
                nodeId: parent.rootNodeId,
                role: "user",
                text: "Background task finished",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "server",
                createdAt: now,
                updatedAt: now,
                delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
              },
            },
          ],
        });
        const { delegatedCompletion: _cohort, ...settledRun } = parent;
        const commit = sink.commitCommand;
        let settled = false;
        let planned: OrchestrationV2Run["delegatedCompletion"];
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(sink, "commitCommand").mockImplementation((input) =>
              Effect.gen(function* () {
                if (!settled && input.commandType === commandType) {
                  settled = true;
                  const plannedRun = input.events.find((event) => event.type === "run.updated");
                  planned =
                    plannedRun?.type === "run.updated"
                      ? plannedRun.payload.delegatedCompletion
                      : undefined;
                  // The provider turn ends (or its checkpoint lands) after the command read the run.
                  yield* commit({
                    commandId: CommandId.make(`command:${race}`),
                    threadId,
                    commandType: capture ? "checkpoint.capture" : "provider.event",
                    acceptedAt: now,
                    effects: [],
                    events: [
                      {
                        id: EventId.make(`event:${race}-settled`),
                        type: "run.updated",
                        threadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          ...settledRun,
                          status: after,
                          completedAt: now,
                          checkpointId: capture ? checkpointId : null,
                        },
                      },
                    ],
                  });
                }
                return yield* commit(input);
              }),
            ),
          ),
          () =>
            orchestrator.dispatch(
              command === "accept"
                ? {
                    type: "notification.delivery.accept",
                    commandId: CommandId.make(`command:${race}:accept`),
                    threadId,
                    messageId,
                  }
                : command === "wake-policy"
                  ? {
                      type: "delegated_task.wake-policy",
                      commandId: CommandId.make(`command:${race}:wake-policy`),
                      parentThreadId: threadId,
                      taskId,
                      completionWake: "always",
                    }
                  : {
                      type: "delegated_task.completion-delivery.acknowledge",
                      commandId: CommandId.make(`command:${race}:task-status`),
                      parentThreadId: threadId,
                      taskId,
                      observedByRunId: runId,
                    },
            ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        assert.isTrue(settled);
        const finished = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          finished.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
          { acknowledge: "acknowledged", accept: "delivered", "wake-policy": "claimed" }[command],
        );
        const run = finished.runs.find((candidate) => candidate.id === runId)!;
        assert.deepEqual(
          {
            status: run.status,
            completedAt: run.completedAt,
            checkpointId: run.checkpointId,
            delegatedCompletion: run.delegatedCompletion,
          },
          {
            status: after,
            completedAt: now,
            checkpointId: capture ? checkpointId : null,
            delegatedCompletion: planned,
          },
        );
      }),
  );
});
