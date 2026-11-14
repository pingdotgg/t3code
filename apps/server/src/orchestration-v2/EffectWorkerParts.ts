import { CommandId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  increment,
  metricAttributes,
  orchestrationEffectClaimsTotal,
  orchestrationEffectQueueWait,
} from "../observability/Metrics.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import { OrchestrationEffectExecutionError, OrchestrationEffectExecutorV2, isNonRetryableProviderTurnControlFailure } from "./EffectWorker.ts";

export const layerExecutor: Layer.Layer<
  OrchestrationEffectExecutorV2,
  never,
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunFinalizationService.RunFinalizationService
  | CheckpointRollbackService.CheckpointRollbackServiceV2
  | ProviderTurnControlService.ProviderTurnControlServiceV2
  | ProviderTurnStartService.ProviderTurnStartServiceV2
  | RuntimeRequestService.RuntimeRequestServiceV2
  | ThreadTitleRegenerationService.ThreadTitleRegenerationService
  | ThreadManagementService.ThreadManagementService
  | ServerSettings.ServerSettingsService
> = Layer.suspend(() =>
  Layer.effect(
  OrchestrationEffectExecutorV2,
  Effect.gen(function* () {
    const runFinalization = yield* RunFinalizationService.RunFinalizationService;
    const resourceCleanup = yield* ResourceCleanupService.ResourceCleanupService;
    const checkpointRollback = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const providerTurnControl = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
    const providerTurnStart = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
    const runtimeRequests = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const threadTitleRegeneration =
      yield* ThreadTitleRegenerationService.ThreadTitleRegenerationService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    return OrchestrationEffectExecutorV2.of({
      execute: Effect.fn("OrchestrationEffectExecutorV2.execute")(function (effect, options) {
        const willRetry = options?.willRetry ?? false;
        switch (effect.request.type) {
          case "provider-runtime.continue": {
            const sourceRunId = effect.request.sourceRunId;
            return continueRestartedRun({ threadId: effect.threadId, sourceRunId }).pipe(
              Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
              Effect.provideService(ServerSettings.ServerSettingsService, settings),
              Effect.tapError(() =>
                willRetry
                  ? Effect.void
                  : threads.recoverDelegatedTask(effect.threadId, sourceRunId),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          }
          case "provider-session.detach":
            return providerSessions
              .detach({
                providerSessionId: effect.request.providerSessionId,
                threadId: effect.threadId,
                ...(effect.request.detail === undefined ? {} : { detail: effect.request.detail }),
                ...(effect.request.revokeMcpCredential === undefined
                  ? {}
                  : { revokeMcpCredential: effect.request.revokeMcpCredential }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-turn.start":
            return providerTurnStart
              .start({ threadId: effect.threadId, runId: effect.request.runId, willRetry })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-turn.interrupt": {
            const request = effect.request;
            return providerTurnControl
              .interrupt({
                threadId: effect.threadId,
                providerSessionId: request.providerSessionId,
                providerThreadId: request.providerThreadId,
                providerTurnId: request.providerTurnId,
                ...(request.subagent === undefined
                  ? {}
                  : {
                      subagent: {
                        ...request.subagent,
                        requestedAt: DateTime.makeUnsafe(effect.createdAt),
                      },
                    }),
              })
              .pipe(
                Effect.tapError((cause) =>
                  request.subagent === undefined
                    ? Effect.void
                    : Effect.logWarning("orchestration-v2.subagent-stop-failed", {
                        effectId: effect.id,
                        cause,
                      }),
                ),
                Effect.map((outcome) => ({ unresponsive: false, outcome }) as const),
                // Settling here would end the run while the agent may still be running; the
                // user decides with Force stop instead.
                Effect.catchIf(
                  (cause) => request.subagent === undefined && cause.unresponsive === true,
                  () => Effect.succeed({ unresponsive: true, outcome: undefined } as const),
                ),
                Effect.catchIf(
                  (cause) =>
                    request.subagent === undefined &&
                    isNonRetryableProviderTurnControlFailure(
                      request.type,
                      Cause.pretty(Cause.fail(cause)),
                    ),
                  () => Effect.succeed({ unresponsive: false, outcome: undefined } as const),
                ),
                Effect.andThen(({ unresponsive, outcome }) =>
                  unresponsive
                    ? threads.dispatch({
                        type: "thread.interrupt.unresponsive",
                        commandId: CommandId.make(`${effect.id}:unresponsive`),
                        threadId: effect.threadId,
                        providerThreadId: request.providerThreadId,
                        providerTurnId: request.providerTurnId,
                      })
                    : request.subagent !== undefined && outcome === undefined
                      ? Effect.void
                      : threads.dispatch({
                          type: "thread.background-work.settle",
                          commandId: CommandId.make(`${effect.id}:background-work-settled`),
                          ...(request.subagent === undefined || outcome === undefined
                            ? {}
                            : {
                                subagent: {
                                  id: request.subagent.id,
                                  stoppedAt: DateTime.makeUnsafe(effect.createdAt),
                                  outcome,
                                },
                              }),
                          threadId: effect.threadId,
                          providerThreadId: request.providerThreadId,
                          providerTurnId: request.providerTurnId,
                        }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: request.type,
                      cause,
                    }),
                ),
              );
          }
          case "provider-turn.steer":
            return providerTurnControl
              .steer({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                providerThreadId: effect.request.providerThreadId,
                providerTurnId: effect.request.providerTurnId,
                messageId: effect.request.messageId,
              })
              .pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (effect.request.type !== "provider-turn.steer") return;
                    const messageId = effect.request.messageId;
                    const projection = yield* threads.getThreadRecords(
                      effect.threadId,
                      ["messages", "runs"],
                      { messageIds: [effect.request.messageId] },
                    );
                    const message = projection.messages.find((row) => row.id === messageId);
                    if (message?.delegatedCompletion === undefined) return;
                    yield* threads.dispatch({
                      type: "notification.delivery.accept",
                      commandId: CommandId.make(`command:mailbox-accepted:${effect.id}`),
                      threadId: effect.threadId,
                      messageId: message.id,
                    });
                  }),
                ),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    if (
                      !("turnCompleted" in error) ||
                      !error.turnCompleted ||
                      effect.request.type !== "provider-turn.steer"
                    ) {
                      return yield* error;
                    }
                    const projection = yield* threads.getThreadRecords(
                      effect.threadId,
                      ["messages", "runs"],
                      { messageIds: [effect.request.messageId] },
                    );
                    const messageId = effect.request.messageId;
                    const message = projection.messages.find((item) => item.id === messageId);
                    const run = projection.runs.find((item) => item.id === message?.runId);
                    if (message === undefined || run === undefined) return yield* error;
                    // Notifications must be queued messages.
                    const queued =
                      message.delegatedCompletion !== undefined ||
                      message.notification !== undefined;
                    // Reuse message ids and receipts so retries cannot duplicate messages or follow-ups.
                    yield* threads
                      .dispatch({
                        type: "message.dispatch",
                        commandId: CommandId.make(`command:steer-follow-up:${effect.id}`),
                        threadId: effect.threadId,
                        messageId: message.id,
                        text: message.text,
                        ...(message.context ? { context: message.context } : {}),
                        attachments: message.attachments,
                        ...(message.delegatedCompletion === undefined
                          ? {}
                          : { modelSelection: run.modelSelection }),
                        dispatchMode: {
                          type: queued ? "queue_after_active" : "start_immediately",
                        },
                        createdBy: message.createdBy,
                        creationSource: message.creationSource,
                        ...(message.delegatedCompletion === undefined
                          ? {}
                          : { delegatedCompletion: message.delegatedCompletion }),
                        ...(message.notification === undefined
                          ? {}
                          : { notification: message.notification }),
                        ...(message.scheduledTaskId === undefined
                          ? {}
                          : { scheduledTaskId: message.scheduledTaskId }),
                        ...(message.senderThreadId === undefined
                          ? {}
                          : { senderThreadId: message.senderThreadId }),
                      })
                      .pipe(
                        // A disabled instance cannot retry this completed turn; its result stands.
                        Effect.catchTags({
                          ThreadManagementProviderInstanceDisabledError: (disabledError) =>
                            Effect.logInfo(
                              "orchestration-v2.effect-worker.steer-follow-up-disabled",
                              {
                                threadId: effect.threadId,
                                messageId: message.id,
                                projectId: disabledError.projectId,
                                instanceId: disabledError.instanceId,
                              },
                            ),
                        }),
                      );
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-turn.restart":
            return providerTurnControl
              .interruptAndAwaitTerminal({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                providerThreadId: effect.request.providerThreadId,
                providerTurnId: effect.request.providerTurnId,
                interruptedAttemptId: effect.request.interruptedAttemptId,
                ...(effect.request.sessionTransition?.type === "replace"
                  ? {
                      replacementProviderSessionId:
                        effect.request.sessionTransition.replacementProviderSessionId,
                    }
                  : {}),
              })
              .pipe(
                Effect.andThen(
                  effect.request.sessionTransition?.type === "replace"
                    ? providerSessions.detach({
                        providerSessionId: effect.request.providerSessionId,
                        threadId: effect.threadId,
                        detail: "Selection change requires a provider session restart.",
                      })
                    : effect.request.sessionTransition?.type === "detach"
                      ? providerSessions.detach({
                          providerSessionId: effect.request.providerSessionId,
                          threadId: effect.threadId,
                          detail: "Provider thread handoff replaced this session binding.",
                        })
                      : Effect.void,
                ),
                Effect.andThen(
                  providerTurnStart.start({
                    threadId: effect.threadId,
                    runId: effect.request.runId,
                    willRetry,
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "runtime-request.respond": {
            const requestId = effect.request.requestId;
            return runtimeRequests
              .respond({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                requestId: effect.request.requestId,
                ...(effect.request.decision === undefined
                  ? {}
                  : { decision: effect.request.decision }),
                ...(effect.request.feedback === undefined
                  ? {}
                  : { feedback: effect.request.feedback }),
                ...(effect.request.answers === undefined
                  ? {}
                  : { answers: effect.request.answers }),
              })
              .pipe(
                Effect.tapCause((cause) =>
                  willRetry || Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : threads
                        .dispatch({
                          type: "runtime-request.delivery.fail",
                          commandId: CommandId.make(`${effect.commandId}:delivery-failed`),
                          threadId: effect.threadId,
                          requestId,
                        })
                        .pipe(
                          Effect.catchCause((recordCause) =>
                            Effect.logWarning("Failed to record answer delivery failure", {
                              effectId: effect.id,
                              cause: recordCause,
                            }),
                          ),
                        ),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          }
          case "provider-thread.rollback":
            return checkpointRollback
              .execute({
                threadId: effect.threadId,
                providerThreadId: effect.request.providerThreadId,
                checkpointId: effect.request.checkpointId,
                scopeId: effect.request.scopeId,
                ...(effect.request.restoreFiles === undefined
                  ? {}
                  : { restoreFiles: effect.request.restoreFiles }),
              })
              .pipe(
                Effect.tapCause((cause) =>
                  willRetry || Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : threads
                        .dispatch({
                          type: "checkpoint.rollback.fail",
                          commandId: CommandId.make(`${effect.commandId}:rollback-failed`),
                          threadId: effect.threadId,
                          requestId: effect.commandId,
                          message: Option.match(Cause.findErrorOption(cause), {
                            onNone: () => CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE,
                            onSome: CheckpointRollbackService.rollbackFailureClientMessage,
                          }),
                        })
                        .pipe(
                          Effect.catchCause((recordCause) =>
                            Effect.logWarning("Failed to record rollback failure", {
                              effectId: effect.id,
                              cause: recordCause,
                            }),
                          ),
                        ),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "checkpoint.capture":
            return runFinalization
              .finalize({
                threadId: effect.threadId,
                runId: effect.request.runId,
                scopeId: effect.request.scopeId,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "scheduled-tasks.cleanup":
            return resourceCleanup.cleanupScheduledTasks(effect.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "terminal.cleanup":
            return resourceCleanup.cleanupTerminals(effect.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "preview.cleanup":
            return resourceCleanup.cleanupPreviews(effect.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "attachment.cleanup":
            return resourceCleanup.cleanupAttachments(effect.request.attachmentIds).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "thread-title.generate":
            return threadTitleRegeneration
              .execute({
                threadId: effect.threadId,
                requestId: effect.commandId,
                kind: effect.request.kind,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "delegated-tasks.stop":
            return threads
              .stopDelegatedTasks({
                threadId: effect.threadId,
                commandId: effect.commandId,
                reason: effect.request.reason,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
        }
      }),
    });
  }),
  ),
);

// A running effect blocks later work on its thread and its lease is never reclaimed in-process,
// so a stop that hangs must give up and fall through to the normal retry/fail path.
