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

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "subagent follow-ups",
  (it) => {
    it.effect("recovers a reserved delivery without loading conversation history", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:bounded-delivery-recovery");
        const runId = RunId.make("run:bounded-delivery-recovery");
        const taskId = NodeId.make("task:bounded-delivery-recovery");
        yield* seedParentWithTerminalTask({
          threadId,
          runId,
          taskId,
          projectId: ProjectId.make("project:bounded-delivery-recovery"),
          rootNodeId: NodeId.make("node:bounded-delivery-recovery"),
          deliveryState: "claimed",
          deliveryTaskIds: [taskId],
          completionWake: "always",
          now,
        });
        for (const suffix of ["first", "second"]) {
          yield* sink.write({
            events: [
              {
                id: EventId.make(`event:bounded-delivery-history:${suffix}`),
                type: "message.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`message:bounded-delivery-history:${suffix}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  createdBy: "user",
                  creationSource: "web",
                  role: "user",
                  text: "Unrelated historical input",
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        }
        const statements: string[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              const query = span.attributes.get("db.query.text");
              if (typeof query === "string") statements.push(query);
            };
            return span;
          },
        });
        yield* orchestrator.recoverDelegatedTasks.pipe(Effect.withTracer(tracer));
        assert.isFalse(statements.some((query) => query.includes("MIN(ordinal)")));
        const messageReads = statements.filter((query) =>
          query.includes("FROM orchestration_v2_projection_messages"),
        );
        assert.isNotEmpty(messageReads);
        assert.isTrue(messageReads.every((query) => query.includes("message_id IN")));
        const wake = yield* requests.take;
        assert.equal(wake.delegatedCompletion?.parentRunId, runId);
      }),
    );

    it.effect("keeps a checkpoint completion committed between finalize's read and write", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:completion-capture-race");
        const projectId = ProjectId.make("project:completion-capture-race");
        const runId = RunId.make("run:completion-capture-race");
        const rootNodeId = NodeId.make("node:completion-capture-race");
        const checkpointId = CheckpointId.make("checkpoint:completion-capture-race");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make("node:completion-capture-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const waiting = { ...parent, status: "waiting" as const };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:completion-capture-waiting"),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: waiting,
            },
          ],
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: "completion-capture-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        const write = sink.writeWithEffects;
        let captured = false;
        const committedParentRuns: Array<OrchestrationV2Run> = [];
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(sink, "writeWithEffects").mockImplementation((input) =>
              Effect.gen(function* () {
                if (
                  !captured &&
                  input.events.some(
                    (event) =>
                      event.type === "run.updated" &&
                      event.payload.id === runId &&
                      event.payload.delegatedCompletion?.delivery != null,
                  )
                ) {
                  captured = true;
                  // Commit capture after finalize planned its stale waiting snapshot.
                  const { delegatedCompletion: _cohort, ...captureRun } = waiting;
                  yield* sink.commitCommand({
                    commandId: CommandId.make("command:completion-capture-race"),
                    threadId,
                    commandType: "checkpoint.capture",
                    acceptedAt: now,
                    effects: [],
                    events: [
                      {
                        id: EventId.make("event:completion-capture-completed"),
                        type: "run.updated",
                        threadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          ...captureRun,
                          status: "completed",
                          completedAt: now,
                          checkpointId,
                        },
                      },
                    ],
                  });
                }
                const stored = yield* write(input);
                for (const { event } of stored) {
                  if (event.type === "run.updated" && event.payload.id === runId) {
                    committedParentRuns.push(event.payload);
                  }
                }
                return stored;
              }),
            ),
          ),
          () => orchestrator.recoverDelegatedTasks,
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        assert.isTrue(captured);
        assert.equal(committedParentRuns.length, 1);
        const committedParentRun = committedParentRuns[0];
        assert.equal(committedParentRun?.status, "completed");
        assert.deepEqual(committedParentRun?.completedAt, now);
        assert.equal(committedParentRun?.checkpointId, checkpointId);
        assert.deepEqual(committedParentRun?.delegatedCompletion?.delivery?.taskIds, [
          child.taskId,
        ]);
        const finished = yield* orchestrator.getThreadProjection(threadId);
        const completed = finished.runs.find((run) => run.id === runId)!;
        assert.equal(completed.status, "completed");
        assert.deepEqual(completed.completedAt, now);
        assert.equal(completed.checkpointId, checkpointId);
        assert.deepEqual(completed.delegatedCompletion?.delivery?.taskIds, [child.taskId]);
        const wake = yield* requests.take;
        assert.equal(wake.delegatedCompletion?.parentRunId, runId);
        const delivery = completed.delegatedCompletion!.delivery!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make("command:completion-capture-delivery"),
          threadId,
          messageId: delivery.messageId,
          text: "Child finished",
          attachments: [],
          delegatedCompletion: {
            parentRunId: runId,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
          dispatchMode: { type: "queue_after_active" },
        });
        const delivered = yield* orchestrator.getThreadProjection(threadId);
        const deliveryRun = delivered.runs.find((run) => run.userMessageId === delivery.messageId);
        assert.isDefined(deliveryRun);
        assert.notEqual(deliveryRun?.status, "queued");
      }),
    );

    it.effect("pauses queued follow-up cards and resumes them", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:held-followup-parent");
        const projectId = ProjectId.make("project:held-followup");
        const parentRunId = RunId.make("run:held-followup-parent");
        const rootNodeId = NodeId.make("node:held-followup-parent");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:held-followup-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "held-followup-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        yield* orchestrator.recoverDelegatedTasks;
        const send = (name: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make(`command:held-followup:${name}`),
            threadId: child.childThreadId,
            senderThreadId: parentThreadId,
            messageId: MessageId.make(`message:held-followup:${name}`),
            text: name,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
        yield* send("active");
        yield* send("queued");
        const before = yield* orchestrator.getThreadProjection(child.childThreadId);
        const active = before.runs.find((run) => run.ordinal === 2)!;
        const queued = before.runs.find((run) => run.ordinal === 3)!;
        assert.equal(queued.status, "queued");
        const waitForStatus = (afterSequence: number, status: string) =>
          eventSink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.id === queued.delegatedTaskId &&
                stored.event.payload.status === status,
            ),
            Stream.take(1),
            Stream.runHead,
          );
        const afterSequence = yield* eventSink.latestSequence();
        yield* orchestrator.dispatch({
          type: "thread.stop",
          threadId: child.childThreadId,
          commandId: CommandId.make("command:held-followup:stop"),
        });
        yield* waitForStatus(afterSequence, "idle");
        const paused = yield* orchestrator.getThreadProjection(parentThreadId);
        const task = paused.subagents.find((row) => row.id === queued.delegatedTaskId)!;
        assert.equal(task.status, "idle");
        assert.isNull(task.result);
        assert.equal(paused.nodes.find((row) => row.id === task.id)?.status, "idle");
        assert.equal(
          paused.turnItems.find((row) => row.type === "subagent" && row.subagentId === task.id)
            ?.status,
          "idle",
        );
        const endedSequence = yield* eventSink.latestSequence();
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:held-followup-active-ended"),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: active.id,
              occurredAt: now,
              payload: { ...active, status: "interrupted", startedAt: now, completedAt: now },
            },
          ],
        });
        const activeTask = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (row) => row.id === active.delegatedTaskId,
        )!;
        if (activeTask.result === null) {
          yield* eventSink
            .stream({ afterSequence: endedSequence, eventType: "subagent.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === active.delegatedTaskId &&
                  stored.event.payload.status === "interrupted",
              ),
              Stream.take(1),
              Stream.runHead,
            );
        }
        const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (row) => row.id === parentThreadId,
        )!;
        assert.isFalse((shell.pendingBackgroundTasks ?? []).some((row) => row.taskId === task.id));
        const resumeSequence = yield* eventSink.latestSequence();
        yield* orchestrator.dispatch({
          type: "queue.resume",
          threadId: child.childThreadId,
          commandId: CommandId.make("command:held-followup:resume"),
        });
        yield* waitForStatus(resumeSequence, "running");
        const resumed = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(resumed.subagents.find((row) => row.id === task.id)?.status, "running");
        assert.isNull(resumed.subagents.find((row) => row.id === task.id)?.result);
      }),
    );

    it.effect("delivers the run a background command's wake starts after the original result", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:background-wake-parent");
        const projectId = ProjectId.make("project:background-wake");
        const parentRunId = RunId.make("run:background-wake-parent");
        const rootNodeId = NodeId.make("node:background-wake-parent");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:background-wake-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "background-wake-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        yield* orchestrator.recoverDelegatedTasks;
        let firstWake = yield* requests.take;
        while (firstWake.threadId !== parentThreadId) firstWake = yield* requests.take;
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:background-wake-ack"),
          parentThreadId,
          taskId: child.taskId,
          observedByRunId: parentRunId,
        });
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
          (run) => run.id === parentRunId,
        )!;
        yield* eventSink.write({
          commandId: reconcileCommandId("background-wake-parent-finished"),
          events: [
            {
              id: EventId.make("event:background-wake-parent-finished"),
              type: "run.updated",
              threadId: parentThreadId,
              runId: parentRunId,
              occurredAt: now,
              payload: { ...parentRun, status: "completed", completedAt: now },
            },
          ],
        });

        // The shape ProviderContinuationService dispatches when the provider
        // reports a background command (wire kind `background_command`) ended.
        const wakeMessageId = MessageId.make("message:background-wake");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "provider",
          commandId: CommandId.make("command:background-wake"),
          threadId: child.childThreadId,
          messageId: wakeMessageId,
          text: "Background activity updated",
          notification: {
            source: { kind: "command" },
            outcome: "completed",
            summary: 'Command "sleep 60" finished',
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        const run = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.find(
          (row) => row.userMessageId === wakeMessageId,
        )!;
        assert.isDefined(run.delegatedTaskId);
        yield* eventSink.write({
          commandId: reconcileCommandId("background-wake-finished"),
          events: [
            {
              id: EventId.make("event:background-wake-result"),
              type: "message.updated",
              threadId: child.childThreadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: MessageId.make("message:background-wake-result"),
                threadId: child.childThreadId,
                runId: run.id,
                nodeId: null,
                role: "assistant",
                text: "The background command finished cleanly.",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "server",
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("event:background-wake-finished"),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        const followup = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === run.delegatedTaskId,
        )!;
        assert.equal(followup.status, "completed");
        assert.equal(followup.result, "The background command finished cleanly.");
        assert.equal(followup.completionDelivery?.state, "claimed");
        let wake = yield* requests.take;
        while (
          wake.threadId !== parentThreadId ||
          wake.delegatedCompletion?.messageId === firstWake.delegatedCompletion?.messageId
        ) {
          wake = yield* requests.take;
        }
        assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);
      }),
    );
  },
);
