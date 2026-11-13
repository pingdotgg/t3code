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
    const outcomes = [
      "completed",
      "failed",
      "interrupted",
      "restarted",
      "stopped",
      "overlapping",
    ] as const;

    it.effect.each(outcomes)(
      "delivers a %s follow-up independently of the original task",
      (outcome) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const parentThreadId = ThreadId.make(`thread:followup-${outcome}`);
          const projectId = ProjectId.make(`project:followup-${outcome}`);
          const parentRunId = RunId.make(`run:followup-${outcome}`);
          const rootNodeId = NodeId.make(`node:followup-${outcome}`);
          yield* seedParentWithTerminalTask({
            threadId: parentThreadId,
            projectId,
            runId: parentRunId,
            rootNodeId,
            taskId: NodeId.make(`node:seed-${outcome}`),
            deliveryState: "acknowledged",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId,
            projectId,
            parentRunId,
            rootNodeId,
            name: `followup-child-${outcome}`,
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          yield* orchestrator.recoverDelegatedTasks;
          let firstWake = yield* requests.take;
          while (firstWake.threadId !== parentThreadId) firstWake = yield* requests.take;
          assert.equal(firstWake.delegatedCompletion?.parentRunId, parentRunId);
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make(`command:followup-ack-${outcome}`),
            parentThreadId,
            taskId: child.taskId,
            observedByRunId: parentRunId,
          });
          const original = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === child.taskId,
          )!;
          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
            (run) => run.id === parentRunId,
          )!;
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-parent-finished-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-parent-finished-${outcome}`),
                type: "run.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: { ...parentRun, status: "completed", completedAt: now },
              },
            ],
          });
          const messageId = MessageId.make(`message:followup-${outcome}`);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: outcome === "failed" ? "user" : "agent",
            creationSource: outcome === "failed" ? "web" : "mcp",
            commandId: CommandId.make(`command:followup-send-${outcome}`),
            threadId: child.childThreadId,
            senderThreadId: parentThreadId,
            messageId,
            text: "Check the same work again.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
          let run = childProjection.runs.find((row) => row.userMessageId === messageId)!;
          assert.isDefined(run.delegatedTaskId);
          const workingParent = yield* orchestrator.getShellSnapshot();
          const backgroundTask = workingParent.threads
            .find((thread) => thread.id === parentThreadId)
            ?.pendingBackgroundTasks?.find((task) => task.kind === "subagent");
          assert.equal(backgroundTask?.childThreadId, child.childThreadId);
          if (outcome === "overlapping") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:overlapping-followup"),
              threadId: child.childThreadId,
              senderThreadId: parentThreadId,
              messageId: MessageId.make("message:overlapping-followup"),
              text: "Keep working on another follow-up.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
            });
          }
          if (outcome === "restarted") {
            const cut = { ...run, status: "cancelled" as const, startedAt: now, completedAt: now };
            yield* eventSink.writeWithEffects({
              commandId: reconcileCommandId("followup-restart-cut"),
              events: [
                {
                  id: EventId.make("event:followup-restart-cut"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: run.id,
                  occurredAt: now,
                  payload: cut,
                },
              ],
              effects: [
                {
                  id: `effect:restart-continuation:${run.id}`,
                  commandId: reconcileCommandId("followup-restart-cut"),
                  threadId: child.childThreadId,
                  request: { type: "provider-runtime.continue", sourceRunId: run.id },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            assert.isNull(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === run.delegatedTaskId,
              )!.result,
            );
            const continuationMessageId = MessageId.make("message:followup-restart-continuation");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-restart-continuation"),
              threadId: child.childThreadId,
              restartContinuationOfRunId: run.id,
              messageId: continuationMessageId,
              text: "Continue where you left off.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const continuation = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((row) => row.userMessageId === continuationMessageId)!;
            assert.equal(continuation.delegatedTaskId, run.delegatedTaskId);
            run = continuation;
          }
          if (outcome === "stopped") {
            yield* orchestrator.dispatch({
              type: "thread.stop",
              threadId: parentThreadId,
              commandId: CommandId.make(`command:followup-stop-${outcome}`),
            });
          }
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-finish-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-finish-${outcome}`),
                type: "run.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...run,
                  status:
                    outcome === "stopped"
                      ? "interrupted"
                      : outcome === "restarted" || outcome === "overlapping"
                        ? "completed"
                        : outcome,
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
          });
          yield* orchestrator.recoverDelegatedTasks;
          const finished = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.deepEqual(
            finished.subagents.find((task) => task.id === child.taskId),
            original,
          );
          const followup = finished.subagents.find((task) => task.id === run.delegatedTaskId)!;
          if (outcome === "overlapping") {
            const later = finished.subagents.find(
              (task) =>
                task.childThreadId === child.childThreadId &&
                task.id !== child.taskId &&
                task.id !== followup.id,
            )!;
            assert.equal(later.status, "pending");
            assert.isNull(later.result);
          }
          assert.equal(
            followup.status,
            outcome === "stopped"
              ? "interrupted"
              : outcome === "restarted" || outcome === "overlapping"
                ? "completed"
                : outcome,
          );
          assert.equal(
            followup.completionDelivery?.state,
            outcome === "stopped" ? "disposed" : "claimed",
          );
          if (outcome !== "stopped") {
            let wake = yield* requests.take;
            while (
              wake.threadId !== parentThreadId ||
              wake.delegatedCompletion?.messageId === firstWake.delegatedCompletion?.messageId
            ) {
              wake = yield* requests.take;
            }
            assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);
            assert.notEqual(
              wake.delegatedCompletion?.messageId,
              firstWake.delegatedCompletion?.messageId,
            );
          }
          assert.equal(
            finished.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === child.childThreadId,
            ).length,
            2,
          );
          yield* orchestrator.recoverDelegatedTasks;
          const recovered = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.equal(recovered.contextTransfers.length, finished.contextTransfers.length);
          if (outcome === "completed") {
            const automaticMessageId = MessageId.make("message:followup-automatic-wake");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-automatic-wake"),
              threadId: child.childThreadId,
              messageId: automaticMessageId,
              text: "A monitor reported new output.",
              attachments: [],
              notification: {
                source: { kind: "monitor" },
                outcome: "updated",
                summary: "Monitor updated",
              },
              dispatchMode: { type: "queue_after_active" },
            });
            const automatic = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((run) => run.userMessageId === automaticMessageId)!;
            assert.isUndefined(automatic.delegatedTaskId);
            yield* eventSink.write({
              commandId: reconcileCommandId("followup-automatic-finished"),
              events: [
                {
                  id: EventId.make("event:followup-automatic-finished"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: automatic.id,
                  occurredAt: now,
                  payload: { ...automatic, status: "completed", startedAt: now, completedAt: now },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterAutomatic = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.deepEqual(afterAutomatic.subagents, recovered.subagents);
            assert.equal(afterAutomatic.contextTransfers.length, recovered.contextTransfers.length);
            const control = yield* seedRestartCancelledChild({
              parentThreadId,
              projectId,
              parentRunId,
              rootNodeId,
              name: "followup-control-child",
              completionWake: "always",
              continuationPending: false,
              runStatus: "completed",
              now,
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterControl = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.equal(
              afterControl.subagents.find((task) => task.id === control.taskId)?.completionDelivery
                ?.state,
              "claimed",
            );
            assert.equal(
              afterControl.contextTransfers.filter(
                (transfer) =>
                  transfer.type === "subagent_result" &&
                  transfer.sourceThreadId === control.childThreadId,
              ).length,
              1,
            );
          }
        }),
    );

    it.effect("serializes a recovered child answer with its parent and tracks the follow-up", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:question-answer-parent");
        const projectId = ProjectId.make("project:question-answer");
        const parentRunId = RunId.make("run:question-answer-parent");
        const rootNodeId = NodeId.make("node:question-answer-parent");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:question-answer-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "question-answer-child",
          completionWake: "always",
          continuationPending: false,
          now,
        });
        // The cancelled result is published before anyone answers the question.
        yield* orchestrator.recoverDelegatedTasks;
        assert.isNotNull(
          (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === child.taskId,
          )?.result,
        );
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
          (run) => run.id === parentRunId,
        )!;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:question-answer-parent-completed"),
              type: "run.updated",
              threadId: parentThreadId,
              runId: parentRunId,
              occurredAt: now,
              payload: { ...parentRun, status: "completed", completedAt: now },
            },
          ],
        });
        const requestId = RuntimeRequestId.make("request:question-answer");
        const nodeId = NodeId.make("node:question-answer-request");
        yield* eventSink.write({
          commandId: CommandId.make("command:seed-question-answer"),
          events: [
            {
              id: EventId.make("event:question-answer-request"),
              type: "runtime-request.updated",
              threadId: child.childThreadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            },
            {
              id: EventId.make("event:question-answer-item"),
              type: "turn-item.updated",
              threadId: child.childThreadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("turn-item:question-answer"),
                type: "user_input_request",
                threadId: child.childThreadId,
                runId: child.childRunId,
                nodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "waiting",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                requestId,
                questions: [
                  { id: "color", header: "Color", question: "Which color?", options: [] },
                ],
              },
            },
          ],
        });

        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const parentHeld = yield* Deferred.make<void>();
        const releaseParent = yield* Deferred.make<void>();
        const answerWaiting = yield* Deferred.make<void>();
        const withLock = executor.withLock;
        const parentMutation = yield* withLock(
          parentThreadId,
          Deferred.succeed(parentHeld, undefined).pipe(
            Effect.andThen(Deferred.await(releaseParent)),
          ),
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(parentHeld);
        const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
          key,
          effect,
        ) =>
          key === parentThreadId
            ? Deferred.succeed(answerWaiting, undefined).pipe(Effect.andThen(withLock(key, effect)))
            : withLock(key, effect);
        const spy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
        yield* Effect.gen(function* () {
          const answer = yield* orchestrator
            .dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make("command:question-answer"),
              threadId: child.childThreadId,
              requestId,
              answers: { color: "Blue" },
            })
            .pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Effect.raceFirst(Deferred.await(answerWaiting), Fiber.join(answer));
          const waiting = yield* orchestrator.getThreadProjection(child.childThreadId);
          assert.equal(
            waiting.runtimeRequests.find((row) => row.id === requestId)?.status,
            "pending",
          );
          assert.isFalse((yield* executor.activeKeys).includes(child.childThreadId));
          yield* Deferred.succeed(releaseParent, undefined);
          yield* Fiber.join(parentMutation);
          yield* Fiber.join(answer);
        }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));

        const answerRun = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.find(
          (run) => run.userMessageId === MessageId.make(`async-answer:${requestId}`),
        );
        assert.isDefined(answerRun?.delegatedTaskId);
        const followup = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === answerRun?.delegatedTaskId,
        );
        assert.equal(followup?.childThreadId, child.childThreadId);
        assert.isNull(followup?.result);
        assert.isTrue(
          (yield* orchestrator.getThreadShell(parentThreadId))?.pendingBackgroundTasks?.some(
            (task) => task.kind === "subagent" && task.childThreadId === child.childThreadId,
          ),
        );
      }),
    );
  },
);
