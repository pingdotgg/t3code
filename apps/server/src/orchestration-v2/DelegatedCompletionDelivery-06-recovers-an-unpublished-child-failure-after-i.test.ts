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
  it.effect(
    "recovers an unpublished child failure after its completion delivery was disposed",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:unpublished-failure-parent");
        const projectId = ProjectId.make("project:unpublished-failure-parent");
        const runId = RunId.make("run:unpublished-failure-parent");
        const rootNodeId = NodeId.make("node:unpublished-failure-parent-root");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make("node:unpublished-failure-parent-settled"),
          deliveryState: "delivered",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: "unpublished-failure-child",
          completionWake: "always",
          continuationPending: false,
          now,
        });
        // Skip the live terminal listener to model a committed failure whose
        // publication was interrupted. task_cancel then disposed its delivery.
        yield* eventSink.write({
          commandId: reconcileCommandId("unpublished-failure"),
          events: [
            runEvent({
              threadId: child.childThreadId,
              runId: child.childRunId,
              ordinal: 1,
              status: "failed",
              now,
            }),
          ],
        });
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:unpublished-failure-dispose"),
          parentThreadId: threadId,
          taskId: child.taskId,
        });
        yield* orchestrator.recoverDelegatedTasks;
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        const task = recovered.subagents.find((row) => row.id === child.taskId);
        assert.equal(task?.status, "failed");
        assert.equal(task?.result, "Child task ended with status failed.");
        assert.equal(task?.completionDelivery?.state, "disposed");
        assert.lengthOf(recovered.runs, 1);
        assert.lengthOf(
          recovered.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
          1,
        );
        yield* orchestrator.recoverDelegatedTasks;
        assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), recovered);
      }),
  );

  it.effect("wakes the parent for a settled_only task once its spawning turn ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:settled-only-restart");
      const projectId = ProjectId.make("project:settled-only-restart");
      const runId = RunId.make("run:settled-only-restart");
      const rootNodeId = NodeId.make("node:settled-only-restart-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:settled-only-restart-settled"),
        deliveryState: "delivered",
        now,
      });
      yield* eventSink.write({
        commandId: reconcileCommandId("settled-only-restart"),
        events: [
          runEvent({
            threadId,
            runId,
            ordinal: 1,
            status: "cancelled",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: MessageId.make(`message:seed-user:${threadId}`),
            delegatedCompletion: { disposition: "open", nextGeneration: 2, delivery: null },
          }),
          runEvent({
            threadId,
            runId: RunId.make("run:settled-only-restart:continuation"),
            ordinal: 2,
            status: "running",
            now,
            providerThreadId: parentProviderThreadId(threadId),
          }),
        ],
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "settled-only-restart-child",
        completionWake: "settled_only",
        continuationPending: false,
        now,
      });

      yield* orchestrator.recoverDelegatedTasks;

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.subagents.find((row) => row.id === child.taskId)?.completionDelivery?.state,
        "claimed",
      );
      assert.deepEqual(
        projection.runs.find((row) => row.id === runId)?.delegatedCompletion?.delivery?.taskIds,
        [child.taskId],
      );
    }),
  );

  it.effect.each(["a background command", "a nested subagent"] as const)(
    "finalizes a child whose run ended before %s settled",
    (blocker) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const key = blocker === "a background command" ? "command" : "nested";
        const threadId = ThreadId.make(`late-settle-parent-${key}`);
        const runId = RunId.make(`late-settle-parent-run-${key}`);
        const rootNodeId = NodeId.make(`late-settle-parent-root-${key}`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId: ProjectId.make(`late-settle-project-${key}`),
          runId,
          rootNodeId,
          taskId: NodeId.make(`late-settle-seed-task-${key}`),
          deliveryState: "acknowledged",
          now,
        });
        // A delegated child with a running task on the parent and a running run of its own.
        const delegate = (name: string) =>
          Effect.gen(function* () {
            const taskId = NodeId.make(`node:late-settle-${key}-${name}`);
            const childThreadId = ThreadId.make(`thread:late-settle-${key}-${name}`);
            const run = runEvent({
              threadId: childThreadId,
              runId: RunId.make(`run:late-settle-${key}-${name}`),
              ordinal: 1,
              status: "running",
              now,
            });
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`event:late-settle-${key}-${name}:thread`),
                  type: "thread.created",
                  threadId: childThreadId,
                  occurredAt: now,
                  payload: {
                    createdBy: "agent",
                    creationSource: "server",
                    id: childThreadId,
                    projectId: ProjectId.make(`late-settle-project-${key}`),
                    title: name,
                    providerInstanceId: modelSelection.instanceId,
                    modelSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                    activeProviderThreadId: null,
                    lineage: {
                      parentThreadId: threadId,
                      relationshipToParent: "subagent",
                      rootThreadId: threadId,
                    },
                    forkedFrom: { type: "node", nodeId: taskId },
                    createdAt: now,
                    updatedAt: now,
                    archivedAt: null,
                    settledOverride: null,
                    settledAt: null,
                    lastVisitedAt: null,
                    deletedAt: null,
                  },
                },
                {
                  id: EventId.make(`event:late-settle-${key}-${name}:task`),
                  type: "subagent.updated",
                  threadId,
                  runId,
                  nodeId: taskId,
                  driver,
                  providerInstanceId: modelSelection.instanceId,
                  occurredAt: now,
                  payload: {
                    id: taskId,
                    threadId,
                    runId,
                    parentNodeId: rootNodeId,
                    origin: "app_owned",
                    createdBy: "agent",
                    driver,
                    providerInstanceId: modelSelection.instanceId,
                    providerThreadId: null,
                    childThreadId,
                    nativeTaskRef: null,
                    prompt: `Run ${name}.`,
                    title: null,
                    model: null,
                    completionWake: "always",
                    status: "running",
                    result: null,
                    startedAt: now,
                    completedAt: null,
                    updatedAt: now,
                  },
                },
                run,
              ],
            });
            return { task: { id: taskId }, childThreadId, run: run.payload };
          });
        const settled = (taskId: NodeId, afterSequence: number) =>
          sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.id === taskId &&
                stored.event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        const blocked = yield* delegate("blocked");
        const barrier = yield* delegate("barrier");
        const providerThread = {
          id: ProviderThreadId.make(`provider-thread:late-settle-child-${key}`),
          driver,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId: null,
          appThreadId: blocked.childThreadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const nested = {
          id: NodeId.make(`late-settle-nested-${key}`),
          threadId: blocked.childThreadId,
          runId: blocked.run.id,
          parentNodeId: NodeId.make(`late-settle-child-root-${key}`),
          origin: "provider_native" as const,
          createdBy: "agent" as const,
          driver,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Nested work",
          title: null,
          model: null,
          status: "running" as const,
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        const blockerEvent = (open: boolean) =>
          blocker === "a background command"
            ? {
                id: EventId.make(`event:late-settle-roster-${key}-${open}`),
                type: "provider-thread.updated" as const,
                threadId: blocked.childThreadId,
                driver,
                providerInstanceId: modelSelection.instanceId,
                occurredAt: now,
                payload: {
                  ...providerThread,
                  pendingBackgroundTasks: [
                    ...(open
                      ? [{ taskId: "sleep-900", kind: "command" as const, awaited: true as const }]
                      : []),
                    { taskId: "log-watcher", kind: "monitor" as const },
                  ],
                },
              }
            : {
                id: EventId.make(`event:late-settle-nested-${key}-${open}`),
                type: "subagent.updated" as const,
                threadId: blocked.childThreadId,
                runId: blocked.run.id,
                nodeId: nested.id,
                driver,
                providerInstanceId: modelSelection.instanceId,
                occurredAt: now,
                payload: open
                  ? nested
                  : { ...nested, status: "completed" as const, result: "done", completedAt: now },
              };
        const ended = (child: typeof blocked) => ({
          ...runEvent({
            threadId: child.childThreadId,
            runId: child.run.id,
            ordinal: child.run.ordinal,
            status: "completed",
            now,
          }),
          payload: { ...child.run, status: "completed" as const, startedAt: now, completedAt: now },
        });

        const beforeEnd = yield* sink.latestSequence();
        yield* sink.write({ events: [blockerEvent(true)] });
        yield* sink.write({ events: [ended(blocked)] });
        yield* sink.write({ events: [ended(barrier)] });
        // Run updates are handled in order, so the barrier settling means the blocked child's
        // run end was handled too, while its work still ran.
        yield* settled(barrier.task.id, beforeEnd);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
            (task) => task.id === blocked.task.id,
          )?.status,
          "running",
        );

        const beforeSettle = yield* sink.latestSequence();
        yield* sink.write({ events: [blockerEvent(false)] });
        yield* settled(blocked.task.id, beforeSettle);
        const finished = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === blocked.task.id,
        );
        assert.equal(finished?.status, "completed");
        assert.notEqual(finished?.completionDelivery?.state, "disposed");
      }),
  );
});
