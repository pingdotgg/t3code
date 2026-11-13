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
import { lastDeliveredRunForProviderThread, latestContextTransfer, nextRunOrdinal, pendingForkTransferForThread, pendingMergeBackTransfersForThread, rootProviderThreadsForProvider, worktreeSetupPending } from "../Orchestrator.ts";

// Extracted from ./messageHandlers to keep that module under 800 lines.
import type { MessageDispatchInput, MessageRunIdentity } from "./messageDispatchTypes.ts";

export interface FreshRunStartInput extends MessageDispatchInput, MessageRunIdentity {}

export interface FreshRunStartParams {
  deps: MakeMessageHandlersDeps;
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
  input: FreshRunStartInput;
}

export const startFreshRun = Effect.fn("messageStartFreshRun")(function* (
  params: FreshRunStartParams,
) {
  const { deps, command, events, effects } = params;
  const {
    projection,
    modelSelection,
    dispatchMode,
    dispatchText,
    delegatedCompletion,
    continuedTaskId,
    completeSourcePlan,
    runId,
    ordinal,
    now,
    latestCompletedRun,
    legacyImportItems,
    activeProviderThread,
  } = params.input;

  const adapter = yield* deps.providerAdapters.get(modelSelection.instanceId).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorProviderAdapterError({
          commandId: command.commandId,
          providerInstanceId: modelSelection.instanceId,
          cause,
        }),
    ),
  );
  const providerSessionId =
    activeProviderThread?.providerSessionId ??
    (yield* mapDispatchError(command)(
      deps.providerSessionIdFor({
        adapter,
        providerInstanceId: modelSelection.instanceId,
        threadId: command.threadId,
      }),
    ));
  const providerThreadId =
    activeProviderThread?.id ??
    deps.idAllocator.derive.providerThread({
      driver: adapter.driver,
      nativeThreadId: `pending:${runId}`,
    });
  const legacyImportHandoff = shouldPrepareLegacyImportHandoff({
    historyOrigin: projection.thread.historyOrigin,
    hasCompletedRun: latestCompletedRun !== undefined,
    legacyImportItemCount: legacyImportItems.length,
  })
    ? yield* deps.contextHandoffService
        .prepareLegacyImport({
          threadId: command.threadId,
          targetRunId: runId,
          toProviderThreadId: providerThreadId,
          toProviderInstanceId: modelSelection.instanceId,
          items: legacyImportItems,
          createdAt: now,
        })
        .pipe(mapDispatchError(command))
    : null;
  const providerThread: OrchestrationV2ProviderThread =
    activeProviderThread === undefined
      ? {
          id: providerThreadId,
          driver: adapter.driver,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId,
          appThreadId: command.threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "not_loaded",
          firstRunOrdinal: ordinal,
          lastRunOrdinal: ordinal,
          handoffIds: legacyImportHandoff === null ? [] : [legacyImportHandoff.id],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        }
      : {
          ...(activeProviderThread as OrchestrationV2ProviderThread),
          providerSessionId,
          lastRunOrdinal: ordinal,
          handoffIds: appendContextHandoffId(
            activeProviderThread.handoffIds,
            legacyImportHandoff?.id ?? null,
          ),
          updatedAt: now,
        };
  const attemptId = deps.idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
  const rootNodeId = deps.idAllocator.derive.rootNode({ runId });
  const checkpointScope =
    dispatchMode.type === "defer_start"
      ? null
      : yield* deps.runtimePolicy
          .resolve({
            thread: projection.thread,
            modelSelection,
          })
          .pipe(
            mapDispatchError(command),
            Effect.flatMap((resolvedRuntimePolicy) =>
              deps.checkpointService.prepareRootRunScope({
                threadId: command.threadId,
                runId,
                rootNodeId,
                providerThreadId,
                cwd:
                  resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath ?? process.cwd(),
                createdAt: now,
              }),
            ),
            mapDispatchError(command),
          );
  const run: OrchestrationV2Run = {
    id: runId,
    threadId: command.threadId,
    ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId,
    userMessageId: command.messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: dispatchMode.type === "defer_start" ? "preparing" : "starting",
    queuePosition: null,
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: legacyImportHandoff?.id ?? null,
    ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
    ...(command.restartContinuationOfRunId === undefined
      ? {}
      : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
    ...(dispatchMode.type === "defer_start" && dispatchMode.workspaceStrategy !== undefined
      ? { workspacePreparation: dispatchMode.workspaceStrategy }
      : {}),
    ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
    ...wakeWorkStartedAt(projection.runs, command),
        };
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId,
    runId,
    attemptOrdinal: 1,
    rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    providerThreadId,
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
    providerThreadId,
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
  const turnItem: OrchestrationV2TurnItem = {
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    ...(command.scheduledTaskId === undefined
      ? {}
      : { scheduledTaskId: command.scheduledTaskId }),
    ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
    ...(command.idleCompaction === undefined ? {} : { idleCompaction: command.idleCompaction }),
    id: deps.idAllocator.derive.userTurnItem({ messageId: command.messageId }),
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: yield* deps.nextTurnItemOrdinal(projection),
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "user_message",
    messageId: command.messageId,
    inputIntent: "turn_start",
    text: dispatchText,
    ...(command.context ? { context: command.context } : {}),
    attachments: command.attachments,
    ...(run.contextHandoffId === null ? modelSwitchSince(projection, modelSelection) : {}),
  };
  const preparationTurnItem: OrchestrationV2TurnItem | null =
    dispatchMode.type === "defer_start"
      ? {
          id: deps.idAllocator.derive.turnItemFromProviderItem({
            driver: adapter.driver,
            nativeItemId: `workspace-preparation:${runId}`,
          }),
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: turnItem.ordinal + 1,
          status: "running",
          title: WORKSPACE_PREPARATION_INPUT,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: WORKSPACE_PREPARATION_INPUT,
        }
      : null;
  const emitEvent = deps.emit(events, command);
  yield* emitEvent({
    type: "provider-thread.updated",
    threadId: command.threadId,
    driver: adapter.driver,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: providerThread,
  });
  if (legacyImportHandoff !== null) {
    yield* emitEvent({
      type: "context-handoff.updated",
      threadId: command.threadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: legacyImportHandoff,
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
  yield* emitEvent({
    type: "turn-item.updated",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: notificationTurnItem(
      turnItem,
      message,
      yield* deps.notificationTasks(command.threadId, message, projection.subagents),
    ),
  });
  if (preparationTurnItem !== null) {
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: preparationTurnItem,
    });
  }
  const pendingEffect = {
    id: `effect:${command.commandId}:provider-turn.start:${runId}`,
    commandId: command.commandId,
    threadId: command.threadId,
    request: { type: "provider-turn.start", runId },
  } satisfies PendingOrchestrationEffectV2;
  if (dispatchMode.type !== "defer_start") {
    yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
  }
  return;
});
