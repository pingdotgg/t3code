import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Error } from "@t3tools/provider-core/server/ProviderAdapter";
import type { IdAllocatorV2Error } from "@t3tools/provider-core/server/IdAllocator";
import type { OrchestrationV2Command } from "@t3tools/contracts";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import type { OrchestrationV2InternalCommand } from "@t3tools/contracts";
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import { recordThreadOpen } from "@t3tools/shared/paletteSearch";
import type { CommandId } from "@t3tools/contracts";
import type { ThreadId } from "@t3tools/contracts";
import type { EventIdAllocator } from "../orchestrationEmitters.ts";
import type { CheckpointServiceV2Shape } from "../CheckpointService.ts";
import type { CommandPolicyV2Shape } from "../CommandPolicy.ts";
import type { ContextHandoffServiceV2Shape } from "../ContextHandoffService.ts";
import type { EventSinkV2Shape } from "../EventSink.ts";
import type { ProviderAdapterRegistryV2Shape } from "../ProviderAdapterRegistry.ts";
import type { ProviderSessionManagerV2Shape } from "../ProviderSessionManager.ts";
import type { ProviderSwitchServiceV2Shape } from "../ProviderSwitchService.ts";
import type { RuntimePolicyV2Shape } from "../RuntimePolicy.ts";
import { isCheckpointRestoreIsolated } from "../CheckpointRestoreSafety.ts";
import type { ProjectionRecordField } from "../ProjectionStore.ts";
import type { ProjectionRecordFilter } from "../ProjectionStore.ts";
import type { ProjectionRecords } from "../ProjectionStore.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { OrchestratorCommandRejectedError } from "../orchestrationErrors.ts";
import { OrchestratorDispatchError } from "../orchestrationErrors.ts";
import { OrchestratorDomainEventStreamError } from "../orchestrationErrors.ts";
import { OrchestratorProjectionError } from "../orchestrationErrors.ts";
import { OrchestratorProviderAdapterError } from "../orchestrationErrors.ts";
import { OrchestratorSubagentThreadReadOnlyError } from "../orchestrationErrors.ts";
import { OrchestratorThreadAboveModeLimitError } from "../orchestrationErrors.ts";
import { OrchestratorThreadAlreadyExistsError } from "../orchestrationErrors.ts";
import { RunId } from "@t3tools/contracts";
import { WORKSPACE_PREPARATION_INPUT } from "../orchestrationMessages.ts";
import { applyToProjection } from "../ProjectionStore.ts";
import { cancelledBeforeStart } from "../RestartBackgroundNote.ts";
import { canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-definitions/registry";
import { contextSourcePointForRun } from "../orchestrationCommandQueries.ts";
import { continuationFailedBeforePrompt } from "../RestartBackgroundNote.ts";
import { delegatedCompletionWakeDetail } from "../orchestrationCommandQueries.ts";
import { goalCommandStopsActiveRun } from "../CommandPolicy.ts";
import { isActiveRun } from "../CommandPolicy.ts";
import { isNativeMaintenanceCommand } from "../CommandPolicy.ts";
import { isProviderNativeSubagentThread } from "@t3tools/contracts";
import { isRestartContinuationSource } from "../RestartBackgroundNote.ts";
import { isUndeliveredMailboxSteer } from "../NotificationMailbox.ts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { latestProviderTurnForAttempt } from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import { legacyPullRequestLink } from "../orchestrationCommandQueries.ts";
import { legacyThreadPullRequestKey } from "../../sourceControl/threadPullRequests.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { modelSwitchSince } from "../modelSwitch.ts";
import { normalizeThreadPullRequestKey } from "../../sourceControl/threadPullRequests.ts";
import { notificationTurnItem } from "@t3tools/provider-core/server/notification";
import { parseGoalCommand } from "@t3tools/contracts";
import { providerThreadForRun } from "../orchestrationCommandQueries.ts";
import { readForkHistoryItems } from "../ContextHandoffService.ts";
import { resolveMessageDispatchIntent } from "../CommandPolicy.ts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { threadPullRequestKeysEqual } from "../../sourceControl/threadPullRequests.ts";
import { threadPullRequestsOf } from "../../sourceControl/threadPullRequests.ts";
import { threadShellFromProjection } from "../ProjectionStore.ts";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { visibleConversationItems } from "../ContextHandoffService.ts";
import { visibleDeltaRunOrdinals } from "../ContextHandoffService.ts";
import { visibleThreadPullRequests } from "../../sourceControl/threadPullRequests.ts";
import { wakeWorkStartedAt } from "../orchestrationCommandQueries.ts";
import { withPullRequestWatch } from "../orchestrationCommandQueries.ts";
import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import type { OrchestrationV2ContextTransfer } from "@t3tools/contracts";
import type { OrchestrationV2ContextTransferResolution } from "@t3tools/contracts";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import type { OrchestrationV2ExecutionNode } from "@t3tools/contracts";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import type { OrchestrationV2Run } from "@t3tools/contracts";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { isLiveRun } from "../Orchestrator.ts";
import { shouldPrepareLegacyImportHandoff } from "../Orchestrator.ts";
import type { OrchestrationV2RunAttempt } from "@t3tools/contracts";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import { appendContextHandoffId } from "../Orchestrator.ts";
import { isHandoffSourceRun } from "../Orchestrator.ts";
import { threadPullRequestLinksEqual } from "../Orchestrator.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { MakeMessageHandlersDeps } from "./messageHandlerDeps.ts";
import { makeDispatchThreadMutation } from "./messageThreadMutationHandler.ts";
import { lastDeliveredRunForProviderThread, latestContextTransfer, nextRunOrdinal, pendingForkTransferForThread, pendingMergeBackTransfersForThread, rootProviderThreadsForProvider, worktreeSetupPending } from "../Orchestrator.ts";

// Extracted from ./messageHandlers to keep that module under 800 lines.
import type { MessageDispatchInput } from "./messageDispatchTypes.ts";

export interface QueueMessageRunInput extends MessageDispatchInput {
  readonly queueBehindRun: OrchestrationV2Run;
}

export interface QueueMessageRunParams {
  deps: MakeMessageHandlersDeps;
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
  input: QueueMessageRunInput;
}

export const queueMessageRun = Effect.fn("messageQueueRun")(function* (
  params: QueueMessageRunParams,
) {
    const { deps, command, events, effects } = params;
    const { activeProviderThread,activeRun,completeSourcePlan,continuedTaskId,delegatedCompletion,dispatchText,goalStopRunId,heldRunsToRelease,modelSelection,pendingMergeBackTransfers,projection,queueBehindRun,worktreeMissingRun,worktreeSetupUnresolved } = params.input;

  if (pendingMergeBackTransfers.length > 0) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Thread ${command.threadId} has a pending merge-back transfer; queued merge-back consumption is not implemented yet.`,
  });
  }
  const queueProviderThread =
    activeProviderThread ??
    projection.providerThreads.find(
      (candidate) => candidate.id === queueBehindRun.providerThreadId,
    );
  if (queueProviderThread === undefined) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Active run ${queueBehindRun.id} has no provider thread for queued dispatch.`,
    });
  }
  const now = yield* DateTime.now;
  const ordinal = nextRunOrdinal(projection);
  const runId = deps.idAllocator.derive.run({ threadId: command.threadId, ordinal });
  const targetProviderThread =
    modelSelection.instanceId === queueProviderThread.providerInstanceId
      ? queueProviderThread
      : rootProviderThreadsForProvider(projection, modelSelection.instanceId)[0];
  const queuedAdapter = yield* deps.providerAdapters
    .get(modelSelection.instanceId)
    .pipe(mapDispatchError(command));
  const selectedProviderSession =
    targetProviderThread?.providerSessionId === null ||
    targetProviderThread?.providerSessionId === undefined
      ? undefined
      : projection.providerSessions.find(
          (candidate) => candidate.id === targetProviderThread.providerSessionId,
        );
  const queuedCapabilities =
    selectedProviderSession?.capabilities ??
    (yield* queuedAdapter.getCapabilities().pipe(mapDispatchError(command)));
  yield* mapDispatchError(command)(
    deps.commandPolicy.ensureQueuedMessages({
      commandId: command.commandId,
      threadId: command.threadId,
      providerInstanceId: modelSelection.instanceId,
      capabilities: queuedCapabilities,
    }),
  );
  const queuedProviderThread: OrchestrationV2ProviderThread = targetProviderThread ?? {
    id: deps.idAllocator.derive.providerThread({
      driver: queuedAdapter.driver,
      nativeThreadId: `pending:${runId}`,
    }),
    driver: queuedAdapter.driver,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: null,
    appThreadId: command.threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const attemptId = deps.idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
  const rootNodeId = deps.idAllocator.derive.rootNode({ runId });
  const checkpointScope =
    queueBehindRun.status === "preparing" || worktreeMissingRun !== undefined
      ? null
      : yield* deps.runtimePolicy.resolve({ thread: projection.thread, modelSelection }).pipe(
          Effect.flatMap((resolvedRuntimePolicy) =>
            deps.checkpointService.prepareRootRunScope({
              threadId: command.threadId,
              runId,
              rootNodeId,
              providerThreadId: queuedProviderThread.id,
              cwd:
                resolvedRuntimePolicy.cwd ??
                selectedProviderSession?.cwd ??
                projection.thread.worktreePath ??
                process.cwd(),
              createdAt: now,
            }),
          ),
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
        );
  const queueIsHeld = projection.runs.some(
    (candidate) => candidate.status === "queued" && candidate.queueHeld === true,
  );
  // Buffered wakes need a T3 run for output the CLI already started producing.
  // Stop still holds wakes that arrive before the active run settles.
  const wakeSkipsHold =
    !worktreeSetupUnresolved &&
    activeRun !== undefined &&
    queueIsHeld &&
    command.createdBy === "agent" &&
    command.creationSource === "provider" &&
    !(yield* deps.stopReachedRun(command, command.threadId, activeRun.id));
  const run: OrchestrationV2Run = {
    id: runId,
    threadId: command.threadId,
    ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: queuedProviderThread.id,
    userMessageId: command.messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "queued",
    ...(worktreeMissingRun !== undefined ||
    (heldRunsToRelease.length === 0 && queueIsHeld && !wakeSkipsHold)
      ? { queueHeld: true }
      : {}),
    queuePosition:
      goalStopRunId !== undefined
        ? 1
        : Math.max(
            0,
            ...projection.runs
              .filter((candidate) => candidate.status === "queued")
              .map((candidate) => candidate.queuePosition ?? candidate.ordinal),
          ) + 1,
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
    ...(command.restartContinuationOfRunId === undefined
      ? {}
      : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
    ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
  };
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId,
    runId,
    attemptOrdinal: 1,
    rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    providerThreadId: queuedProviderThread.id,
    providerTurnId: null,
    reason: "initial",
    status: "pending",
    startedAt: null,
    completedAt: null,
  };
  const rootNode: OrchestrationV2ExecutionNode = {
    id: rootNodeId,
    threadId: command.threadId,
    runId,
    parentNodeId: null,
    rootNodeId,
    kind: "root_turn",
    status: "pending",
    countsForRun: true,
    providerThreadId: queuedProviderThread.id,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: checkpointScope?.id ?? null,
    startedAt: null,
    completedAt: null,
  };
  const message: OrchestrationV2ConversationMessage = {
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    ...(command.scheduledTaskId === undefined
      ? {}
      : { scheduledTaskId: command.scheduledTaskId }),
    ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
    ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
    id: command.messageId,
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: dispatchText,
    ...(command.context ? { context: command.context } : {}),
    attachments: command.attachments,
    streaming: false,
    createdAt: now,
    updatedAt: now,
    ...(delegatedCompletion === undefined ? {} : { delegatedCompletion }),
    ...(command.notification === undefined ? {} : { notification: command.notification }),
  };
  const emitEvent = deps.emit(events, command);
  if (targetProviderThread === undefined) {
    yield* emitEvent({
      type: "provider-thread.updated",
      threadId: command.threadId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: queuedProviderThread,
    });
  }
  yield* emitEvent({
    type: "run.created",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: run,
  });
  yield* completeSourcePlan(now);
  yield* emitEvent({
    type: "run-attempt.created",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: attempt,
  });
  yield* emitEvent({
    type: "node.updated",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: rootNode,
  });
  if (checkpointScope !== null) {
    yield* emitEvent({
      type: "checkpoint-scope.created",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: checkpointScope,
    });
  }
  yield* emitEvent({
    type: "message.updated",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: message,
  });
  const existingItem = projection.turnItems.find(
    (item) => item.type === "user_message" && item.messageId === command.messageId,
  );
  if (existingItem?.type === "user_message") {
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: {
        ...existingItem,
        runId,
        nodeId: rootNodeId,
        providerThreadId: queuedProviderThread.id,
        providerTurnId: null,
        inputIntent: "queued_turn",
        status: "pending",
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      },
    });
  }
  if (goalStopRunId !== undefined) {
    return yield* deps.stopRunForQueuedCommand({
      command,
      events,
      effects,
      projection: yield* deps.getProjectionWithPendingEvents(command.threadId, events),
      queuedRunId: runId,
      targetRunId: goalStopRunId,
      reason: "Stopped to apply /goal",
      now,
    });
  }
  return;
});
