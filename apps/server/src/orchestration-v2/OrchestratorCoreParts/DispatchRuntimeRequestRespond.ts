import { threadPullRequestsOf } from "../../sourceControl/threadPullRequests.ts";
import { normalizeThreadPullRequestKey, threadPullRequestKeysEqual } from "../../sourceControl/threadPullRequests.ts";
import { type GuestMessageId, isProviderNativeSubagentThread, MessageId, OrchestrationV2Command, type OrchestrationV2ServerCommand, type OrchestrationV2AppThread, type OrchestrationV2DomainEvent, ProviderInteractionMode, resolveProjectProviderInstanceEnabled, RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { decideGuestMessageSend } from "../GuestShareDecider.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { makeMessageHandlers } from "../handlers/messageHandlers.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { DispatchModeLimit, exceededDispatchModeLimit, narrowToCeiling, runtimeModeCeilingRefusal, threadsStartingWork } from "../DispatchModeLimit.ts";
import { OrchestratorDispatchError, OrchestratorProjectionError, OrchestratorThreadAboveModeLimitError } from "../orchestrationErrors.ts";
import { OrchestratorRuntimeModeAboveCeilingError, decodeUserInputAnswers, isMessageQuestionAnswer, pendingThreadTitleGenerationEffect } from "../OrchestratorCorePrelude/OrchestratorV2Shape.ts";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";
import type { StartNextQueuedRunPart } from "./StartNextQueuedRun.ts";
import type { DispatchDelegatedTaskCompletionDeliveryResolutionPart } from "./DispatchDelegatedTaskCompletionDeliveryResolution.ts";
import type { RecordSubagentFollowupPart } from "./RecordSubagentFollowup.ts";
import type { DispatchSteerIntoRunPart } from "./DispatchSteerIntoRun.ts";
import type { SettleInterruptedRunPart } from "./SettleInterruptedRun.ts";
import type { SettleBackgroundWorkPart } from "./SettleBackgroundWork.ts";
import type { DispatchRunInterruptPart } from "./DispatchRunInterrupt.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart & SettleInterruptedRunPart & SettleBackgroundWorkPart & DispatchRunInterruptPart;

export const installDispatchRuntimeRequestRespond = Effect.fnUntraced(function* (deps: Deps) {
  const { checkpointService, closePendingLinkRequests, commandPolicy, contextHandoffService, dispatchQueuedRunCancel, dispatchSteerIntoRun, disposeAllDelegatedCompletionCohorts, emit, ensureGoalCommandSupported, eventSink, getProjectionWithPendingEvents, goalDriverFor, idAllocator, loadProjectionForCommand, nextTurnItemOrdinal, notificationTasks, projectionStore, projects, providerAdapters, providerSessionIdFor, providerSessions, providerSwitchService, readHandoffItems, readInheritedItems, recordSubagentFollowup, releaseGuestAttachments, runtimeModeCeiling, runtimePolicy, serverSettings, sessionHasBackgroundWork, stopReachedRun, stopRunForQueuedCommand } = deps;

const dispatchPullRequestWatchSync = Effect.fn("orchestrationV2.dispatch.pullRequestWatchSync")(
  function* (
    command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "thread.pull-request-watch.sync" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const thread = yield* projectionStore
      .getThread(command.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    const key = normalizeThreadPullRequestKey(command);
    const link = threadPullRequestsOf(thread).find(
      (candidate) =>
        candidate.source !== "stack-dismissed" && threadPullRequestKeysEqual(candidate, key),
    );
    const inactive =
      thread.archivedAt !== null ||
      thread.settledOverride === "settled" ||
      thread.settledAt !== null ||
      isProviderNativeSubagentThread(thread);
    if (link?.watch?.startedAt !== command.startedAt || (command.wake && inactive)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "The pull request watch ended or its thread settled while it was read.",
      });
    }
    yield* dispatchThreadMutation(command, events, effects);
    if (command.wake === undefined) return;
    yield* dispatchMessage(
      {
        type: "message.dispatch",
        commandId: command.commandId,
        threadId: command.threadId,
        messageId: command.wake.messageId,
        text: command.wake.text,
        notification: command.wake.notification,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      },
      events,
      effects,
    );
  },
);

const emitGuestMessageSent = Effect.fn("orchestrationV2.dispatch.guestMessageSent")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
  guestMessageId: GuestMessageId,
  thread: OrchestrationV2AppThread,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const now = yield* DateTime.now;
  const decided = decideGuestMessageSend({ thread, guestMessageId, now });
  if (Result.isFailure(decided)) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: decided.failure,
    });
  }
  yield* emit(
    events,
    command,
  )({
    type: "thread.guest-share-updated",
    threadId: command.threadId,
    providerInstanceId: thread.providerInstanceId,
    occurredAt: now,
    payload: decided.success.thread,
  });
  return decided.success;
});

const refuseAboveDispatchModeLimit = Effect.fn("orchestrationV2.dispatch.refuseAboveModeLimit")(
  function* (
    command: OrchestrationV2ServerCommand,
    threadId: ThreadId,
    modes: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ) {
    const limit = narrowToCeiling(yield* DispatchModeLimit, runtimeModeCeiling);
    const exceeded = limit === undefined ? undefined : exceededDispatchModeLimit(limit, modes);
    if (limit === undefined || exceeded === undefined) return;
    const refusal = {
      threadId,
      mode: exceeded,
      runtimeMode: modes.runtimeMode,
      interactionMode: modes.interactionMode,
    };
    if (limit.refused !== undefined) yield* Ref.set(limit.refused, refusal);
    return yield* new OrchestratorThreadAboveModeLimitError({
      commandId: command.commandId,
      ...refusal,
    });
  },
);

const refuseAboveRuntimeModeCeiling = Effect.fn(
  "orchestrationV2.dispatch.refuseAboveRuntimeModeCeiling",
)(function* (
  command: OrchestrationV2ServerCommand,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  if (runtimeModeCeiling === undefined) return;
  const runtimeModes = new Map<ThreadId, RuntimeMode>();
  for (const threadId of threadsStartingWork(events)) {
    const thread = yield* projectionStore.getThread(threadId).pipe(
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
      Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
    );
    if (thread !== null) runtimeModes.set(threadId, thread.runtimeMode);
  }
  const refusal = runtimeModeCeilingRefusal(
    runtimeModeCeiling.maxRuntimeMode,
    events,
    runtimeModes,
  );
  if (refusal === undefined) return;
  return yield* new OrchestratorRuntimeModeAboveCeilingError({
    commandId: command.commandId,
    ...refusal,
    ...runtimeModeCeiling,
  });
});

const dispatchRuntimeRequestRespond = Effect.fn("Orchestrator.dispatchRuntimeRequestRespond")(
  function* (
    command: Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const context = yield* projectionStore
      .getRuntimeResponseContext(command.threadId, command.requestId)
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    const runtimeRequest = context.request;
    if (runtimeRequest === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Runtime request ${command.requestId} was not found.`,
      });
    }
    if (runtimeRequest.status !== "pending") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Runtime request ${command.requestId} is ${runtimeRequest.status}.`,
      });
    }
    if (runtimeRequest.responseCapability.type === "not_resumable") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: runtimeRequest.responseCapability.reason,
      });
    }
    if (
      command.feedback !== undefined &&
      (runtimeRequest.responseCapability.type !== "live" ||
        !runtimeRequest.responseCapability.supportsFeedback ||
        runtimeRequest.kind === "user_input" ||
        command.decision !== "decline" ||
        !command.feedback.trim())
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Feedback requires a live approval that supports it and a decline decision.",
      });
    }
    const providerSessionId =
      runtimeRequest.responseCapability.type === "live"
        ? runtimeRequest.responseCapability.providerSessionId
        : null;
    const providerSession = context.session;
    if (providerSessionId !== null && providerSession === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Provider session ${providerSessionId} was not found.`,
      });
    }
    let answers = command.answers;
    if (runtimeRequest.kind === "user_input" && answers !== undefined) {
      const decoded = yield* decodeUserInputAnswers(answers).pipe(mapDispatchError(command));
      answers = Object.fromEntries(
        Object.entries(decoded).map(([questionId, answer]) => [
          questionId,
          typeof answer === "object" && "answers" in answer ? answer.answers : answer,
        ]),
      );
    }

    const approvalTurnItem = context.item;
    const resolvedNodeStatus =
      command.decision === "decline" || command.decision === "cancel"
        ? ("cancelled" as const)
        : ("completed" as const);
    const replies: string[] = [];
    if (
      runtimeRequest.responseCapability.type === "message" &&
      resolvedNodeStatus !== "cancelled"
    ) {
      if (approvalTurnItem?.type !== "user_input_request") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The question for this request was not found.",
        });
      }
      const thread = yield* projectionStore
        .getThread(command.threadId)
        .pipe(mapDispatchError(command));
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      if (
        !resolveProjectProviderInstanceEnabled(
          settings,
          thread.projectId,
          thread.providerInstanceId,
        )
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The provider for this project is disabled.",
        });
      }
      const questionIds = new Set(approvalTurnItem.questions.map((question) => question.id));
      if (
        !Object.entries(answers ?? {}).every(
          ([questionId, answer]) =>
            questionIds.has(questionId) || isMessageQuestionAnswer(answer),
        )
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Answer each question before sending.",
        });
      }
      for (const question of approvalTurnItem.questions) {
        const answer = answers?.[question.id];
        const answered = isMessageQuestionAnswer(answer);
        // Clients send "" for a skipped optional question, such as an attachment-only answer.
        if (!answered && question.required === false) continue;
        if (!answered) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Answer each question before sending.",
          });
        }
        const text = typeof answer === "string" ? answer : answer.join(", ");
        replies.push(`${question.question}\n${text.trim()}`);
      }
      if (replies.length === 0) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Enter an answer before sending.",
        });
      }
    }

    const now = yield* DateTime.now;
    const resolvedRequest = {
      ...runtimeRequest,
      status: "resolved" as const,
      resolvedAt: now,
      ...(command.decision === undefined ? {} : { decision: command.decision }),
      ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
      ...(answers === undefined ? {} : { answers }),
    };
    const emitEvent = emit(events, command);
    const requestNode = context.node;
    if (command.feedback !== undefined) {
      const messageId = MessageId.make(`approval-feedback:${command.requestId}`);
      // Record the reply for every client without dispatching a prompt to the parent agent.
      yield* emitEvent({
        type: "message.updated",
        threadId: command.threadId,
        ...(requestNode?.runId == null ? {} : { runId: requestNode.runId }),
        nodeId: runtimeRequest.nodeId,
        occurredAt: now,
        payload: {
          id: messageId,
          threadId: command.threadId,
          runId: requestNode?.runId ?? null,
          nodeId: runtimeRequest.nodeId,
          role: "user",
          text: command.feedback,
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "server",
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        ...(requestNode?.runId == null ? {} : { runId: requestNode.runId }),
        nodeId: runtimeRequest.nodeId,
        occurredAt: now,
        payload: {
          id: idAllocator.derive.userTurnItem({ messageId }),
          threadId: command.threadId,
          runId: requestNode?.runId ?? null,
          nodeId: runtimeRequest.nodeId,
          providerThreadId:
            context.item?.providerThreadId ?? requestNode?.providerThreadId ?? null,
          providerTurnId: runtimeRequest.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: yield* projectionStore
            .getNextTurnItemOrdinal(command.threadId)
            .pipe(
              Effect.mapError(
                (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
              ),
            ),
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId,
          inputIntent: "steer",
          text: command.feedback,
          attachments: [],
          createdBy: "user",
          creationSource: "server",
        },
      });
    }
    yield* emitEvent({
      type: "runtime-request.updated",
      threadId: command.threadId,
      ...(requestNode?.runId == null ? {} : { runId: requestNode.runId }),
      nodeId: runtimeRequest.nodeId,
      ...(providerSession === undefined
        ? {}
        : {
            driver: providerSession.driver,
            providerInstanceId: providerSession.providerInstanceId,
          }),
      occurredAt: now,
      payload: resolvedRequest,
    });
    if (requestNode !== undefined) {
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        ...(requestNode.runId === null ? {} : { runId: requestNode.runId }),
        nodeId: requestNode.id,
        ...(providerSession === undefined
          ? {}
          : {
              driver: providerSession.driver,
              providerInstanceId: providerSession.providerInstanceId,
            }),
        occurredAt: now,
        payload: {
          ...requestNode,
          status: resolvedNodeStatus,
          completedAt: now,
        },
      });
    }

    if (approvalTurnItem !== undefined) {
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        ...(approvalTurnItem.runId === null ? {} : { runId: approvalTurnItem.runId }),
        ...(approvalTurnItem.nodeId === null ? {} : { nodeId: approvalTurnItem.nodeId }),
        ...(providerSession === undefined
          ? {}
          : {
              driver: providerSession.driver,
              providerInstanceId: providerSession.providerInstanceId,
            }),
        occurredAt: now,
        payload: {
          ...approvalTurnItem,
          ...(approvalTurnItem.type === "user_input_request" && answers !== undefined
            ? {
                questionAnswer: {
                  requestId: command.requestId,
                  answers,
                  attachmentsByQuestionId: command.attachmentsByQuestionId ?? {},
                  questionTextById: Object.fromEntries(
                    approvalTurnItem.questions.map((question) => [
                      question.id,
                      question.question,
                    ]),
                  ),
                },
              }
            : {}),
          status: resolvedNodeStatus,
          completedAt: now,
          updatedAt: now,
        },
      });
    }
    if (runtimeRequest.responseCapability.type === "message") {
      if (resolvedNodeStatus === "cancelled") return;
      let dispatchMode: Extract<
        OrchestrationV2Command,
        { type: "message.dispatch" }
      >["dispatchMode"] = {
        type: "queue_after_active",
      };
      const {
        run: activeRun,
        providerThread: activeProviderThread,
        providerTurn: activeProviderTurn,
      } = yield* projectionStore
        .getRunningTurnContext(command.threadId)
        .pipe(mapDispatchError(command));
      if (activeRun && activeProviderTurn && activeProviderThread?.providerSessionId) {
        const activeSession = yield* providerSessions
          .get(activeProviderThread.providerSessionId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
        if (
          Option.isSome(activeSession) &&
          activeSession.value.providerSession.capabilities.turns.supportsActiveSteering
        ) {
          dispatchMode = { type: "steer_active", targetRunId: activeRun.id };
        }
      }
      const answer = {
        type: "message.dispatch" as const,
        commandId: command.commandId,
        threadId: command.threadId,
        messageId: MessageId.make(`async-answer:${command.requestId}`),
        text: replies.join("\n\n"),
        attachments: [],
        createdBy: "user" as const,
        creationSource: "server" as const,
        dispatchMode,
      };
      yield* dispatchMessage(answer, events, effects);
      return yield* recordSubagentFollowup(answer, events).pipe(mapDispatchError(answer));
    }
    if (providerSessionId === null) return;
    yield* Ref.update(effects, (existing) => [
      ...existing,
      {
        id: `effect:${command.commandId}:runtime-request.respond:${command.requestId}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: {
          type: "runtime-request.respond",
          providerSessionId,
          requestId: command.requestId,
          ...(command.decision === undefined ? {} : { decision: command.decision }),
          ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
          ...(answers === undefined ? {} : { answers }),
        },
      } satisfies PendingOrchestrationEffectV2,
    ]);
  },
);

const { dispatchMessage, dispatchThreadMutation } = makeMessageHandlers({
  checkpointService,
  closePendingLinkRequests,
  commandPolicy,
  contextHandoffService,
  dispatchRuntimeRequestRespond,
  dispatchSteerIntoRun,
  disposeAllDelegatedCompletionCohorts,
  ensureGoalCommandSupported,
  eventSink,
  getProjectionWithPendingEvents,
  goalDriverFor,
  idAllocator,
  loadProjectionForCommand,
  nextTurnItemOrdinal,
  notificationTasks,
  projectionStore,
  projects,
  providerAdapters,
  providerSessionIdFor,
  providerSessions,
  providerSwitchService,
  readHandoffItems,
  readInheritedItems,
  releaseGuestAttachments,
  runtimePolicy,
  sessionHasBackgroundWork,
  stopReachedRun,
  stopRunForQueuedCommand,
  pendingThreadTitleGenerationEffect,
  emit,
  dispatchQueuedRunCancel,
});

  return { dispatchPullRequestWatchSync, emitGuestMessageSent, refuseAboveDispatchModeLimit, refuseAboveRuntimeModeCeiling, dispatchRuntimeRequestRespond, dispatchMessage, dispatchThreadMutation };
});

export type DispatchRuntimeRequestRespondPart = ReturnType<typeof installDispatchRuntimeRequestRespond> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installDispatchRuntimeRequestRespond>;
