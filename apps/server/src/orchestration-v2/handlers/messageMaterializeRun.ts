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
import { queueMessageRun } from "./messageQueueRun.ts";
import { startFreshRun } from "./messageFreshRunStart.ts";
import { resolveRunHandoff } from "./messageRunHandoff.ts";
import { prepareProviderThread } from "./messageProviderThread.ts";
import { lastDeliveredRunForProviderThread, latestContextTransfer, nextRunOrdinal, pendingForkTransferForThread, pendingMergeBackTransfersForThread, rootProviderThreadsForProvider, worktreeSetupPending } from "../Orchestrator.ts";

// Extracted from ./messageHandlers to keep that module under 800 lines.
import type {
  MessageDispatchInput,
  MessageRunIdentity,
  ProviderThreadResult,
  RunHandoffResult,
} from "./messageDispatchTypes.ts";

export interface MaterializeRunInput
  extends MessageDispatchInput,
    MessageRunIdentity,
    RunHandoffResult,
    ProviderThreadResult {}

export interface MaterializeRunParams {
  deps: MakeMessageHandlersDeps;
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
  input: MaterializeRunInput;
}

export const materializeRun = Effect.fn("messageMaterializeRun")(function* (
  params: MaterializeRunParams,
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
    goalStopRunId,
    shouldQueue,
    queueBehindRun,
    worktreeMissingRun,
    activeRun,
    activeProviderThread,
    heldRunsToRelease,
    pendingMergeBackTransfers,
    worktreeSetupUnresolved,
    runId,
    ordinal,
    now,
    isProviderSwitch,
    latestCompletedRun,
    latestHandoffRun,
    legacyImportItems,
    pendingForkTransfer,
    pendingMergeBackTransfer,
    supersededMergeBackTransfers,
    providerSwitchPlan,
    canResumeAcrossInstances,
    sessionsToDetach,
    ensuredProviderThread,
    capabilities,
    existingProviderSession,
    legacyImportRecoveryHandoff,
    portableForkHandoff,
    providerSessionId,
    providerSwitchCoveredRuns,
    providerSwitchHandoff,
    providerSwitchTransferId,
    requiresFullProviderSwitchContext,
    resolvedRuntimePolicy,
    sideChatContextHandoff,
    sideChatFork,
    sideChatWithoutSource,
    sourceRun,
    targetLastCompletedRun,
    canResolveForkNatively,
    attemptId,
    checkpointScope,
    emitEvent,
    mergeBackHandoff,
    mergeBackSourceRun,
    providerThread,
    rootNodeId,
  } = params.input;

const run: OrchestrationV2Run = {
  id: runId,
  threadId: command.threadId,
  ordinal,
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  providerThreadId: providerThread.id,
  userMessageId: command.messageId,
  rootNodeId,
  activeAttemptId: attemptId,
  status: "starting",
  queuePosition: null,
  requestedAt: now,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId:
    portableForkHandoff?.id ??
    providerSwitchHandoff?.id ??
    mergeBackHandoff?.id ??
    legacyImportRecoveryHandoff?.id ??
    null,
  ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
  ...(command.restartContinuationOfRunId === undefined
    ? {}
    : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
  ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
  ...wakeWorkStartedAt(projection.runs, command),
};
const attempt: OrchestrationV2RunAttempt = {
  id: attemptId,
  runId,
  attemptOrdinal: 1,
  rootNodeId,
  providerInstanceId: modelSelection.instanceId,
  providerThreadId: providerThread.id,
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
  providerThreadId: providerThread.id,
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: checkpointScope.id,
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
  providerThreadId: providerThread.id,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: ordinal * 100,
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
  ...(run.contextHandoffId === null
    ? modelSwitchSince(
        projection,
        modelSelection,
        // Side chats do not show the parent's runs.
        sideChatFork ? undefined : sourceRun?.modelSelection,
      )
    : {}),
};
const activeHandoff = portableForkHandoff ?? mergeBackHandoff ?? providerSwitchHandoff;
const handoffSourceRuns =
  portableForkHandoff !== null
    ? sourceRun === null
      ? []
      : [sourceRun]
    : providerSwitchHandoff === null
      ? mergeBackSourceRun === null
        ? []
        : [mergeBackSourceRun]
      : providerSwitchCoveredRuns;
const handoffFromModelSelections = Array.from(
  new Map(
    handoffSourceRuns.map((run) => [
      `${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
      run.modelSelection,
    ]),
  ).values(),
);
const handoffTurnItem: OrchestrationV2TurnItem | null =
  activeHandoff === null
    ? null
    : {
        id: deps.idAllocator.derive.runSignalTurnItem({
          runId,
          signal: `context-handoff:${activeHandoff.id}`,
        }),
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: ordinal * 100 - 1,
        status: "completed",
        title:
          portableForkHandoff !== null
            ? "Fork context"
            : providerSwitchHandoff !== null
              ? "Provider handoff"
              : "Merge-back context",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "handoff",
        contextHandoffId: activeHandoff.id,
        fromProviderThreadIds: activeHandoff.fromProviderThreadIds,
        toProviderThreadId: activeHandoff.toProviderThreadId,
        fromProviderInstanceIds: Array.from(
          new Set(handoffSourceRuns.map((run) => run.providerInstanceId)),
        ),
        toProviderInstanceId: modelSelection.instanceId,
        fromModelSelections: handoffFromModelSelections,
        toModel: modelSelection.model,
        strategy: activeHandoff.strategy,
        summary: activeHandoff.summaryText,
      };
const nativeForkResolution: OrchestrationV2ContextTransferResolution | null =
  !canResolveForkNatively || providerThread.nativeThreadRef === null
    ? null
    : {
        strategy: "native_fork",
        providerThreadRef: providerThread.nativeThreadRef,
      };
const portableForkContext =
  portableForkHandoff ?? (sideChatWithoutSource ? sideChatContextHandoff : null);
const portableForkResolution: OrchestrationV2ContextTransferResolution | null =
  pendingForkTransfer === undefined || portableForkContext === null
    ? null
    : {
        strategy: "portable_context",
        contextHandoffId: portableForkContext.id,
      };
const mergeBackResolution: OrchestrationV2ContextTransferResolution | null =
  pendingMergeBackTransfer === undefined || mergeBackHandoff === null
    ? null
    : {
        strategy: "fork_delta_context",
        contextHandoffId: mergeBackHandoff.id,
      };

if (pendingForkTransfer !== undefined && canResolveForkNatively) {
  yield* emitEvent({
    type: "context-transfer.updated",
    threadId: command.threadId,
    runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: {
      ...pendingForkTransfer,
      targetProviderInstanceId: modelSelection.instanceId,
      targetRunId: runId,
      status: "pending",
      resolution: null,
      error: null,
      updatedAt: now,
    },
  });
}
if (pendingForkTransfer !== undefined && portableForkResolution !== null) {
  yield* emitEvent({
    type: "context-transfer.updated",
    threadId: command.threadId,
    runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: {
      ...pendingForkTransfer,
      targetProviderInstanceId: modelSelection.instanceId,
      targetRunId: runId,
      status: "resolved_portable",
      resolution: portableForkResolution,
      error: null,
      updatedAt: now,
    },
  });
}
yield* emitEvent({
  type: "provider-thread.updated",
  threadId: command.threadId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: now,
  payload: providerThread,
});
if (portableForkHandoff !== null) {
  yield* emitEvent({
    type: "context-handoff.updated",
    threadId: command.threadId,
    runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: portableForkHandoff,
  });
}
if (sideChatContextHandoff !== null) {
  yield* emitEvent({
    type: "context-handoff.updated",
    threadId: command.threadId,
    runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: sideChatContextHandoff,
  });
}
if (legacyImportRecoveryHandoff !== null) {
  yield* emitEvent({
    type: "context-handoff.updated",
    threadId: command.threadId,
    runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: legacyImportRecoveryHandoff,
  });
}
if (
  providerSwitchTransferId !== null &&
  providerSwitchHandoff !== null &&
  latestHandoffRun !== undefined
) {
  const transfer: OrchestrationV2ContextTransfer = {
    id: providerSwitchTransferId,
    type: "provider_handoff",
    sourceThreadId: command.threadId,
    targetThreadId: command.threadId,
    sourcePoint: contextSourcePointForRun(projection, latestHandoffRun),
    basePoint:
      requiresFullProviderSwitchContext || targetLastCompletedRun === undefined
        ? null
        : contextSourcePointForRun(projection, targetLastCompletedRun),
    sourceProviderInstanceId: latestHandoffRun.providerInstanceId,
    targetProviderInstanceId: modelSelection.instanceId,
    targetRunId: runId,
    status: "consumed",
    resolution: {
      strategy:
        providerSwitchHandoff.strategy === "full_thread_summary"
          ? "portable_context"
          : "delta_context",
      contextHandoffId: providerSwitchHandoff.id,
    },
    createdBy: command.createdBy,
    error: null,
    createdAt: now,
    updatedAt: now,
    consumedAt: now,
  };
  yield* emitEvent({
    type: "context-transfer.created",
    threadId: command.threadId,
    runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: transfer,
  });
  yield* emitEvent({
    type: "context-handoff.updated",
    threadId: command.threadId,
    runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: providerSwitchHandoff,
  });
}
if (mergeBackHandoff !== null) {
  yield* emitEvent({
    type: "context-handoff.updated",
    threadId: command.threadId,
    runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: mergeBackHandoff,
  });
}
for (const supersededTransfer of supersededMergeBackTransfers) {
  yield* emitEvent({
    type: "context-transfer.updated",
    threadId: command.threadId,
    runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: {
      ...supersededTransfer,
      status: "superseded",
      error:
        pendingMergeBackTransfer === undefined
          ? "Superseded while consuming merge-back transfer."
          : `Superseded by merge-back transfer ${pendingMergeBackTransfer.id}.`,
      updatedAt: now,
    },
  });
}
if (pendingMergeBackTransfer !== undefined && mergeBackResolution !== null) {
  yield* emitEvent({
    type: "context-transfer.updated",
    threadId: command.threadId,
    runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: {
      ...pendingMergeBackTransfer,
      targetProviderInstanceId: modelSelection.instanceId,
      targetRunId: runId,
      status: "consumed",
      resolution: mergeBackResolution,
      error: null,
      updatedAt: now,
      consumedAt: now,
    },
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
yield* emitEvent({
  type: "checkpoint-scope.created",
  threadId: command.threadId,
  runId,
  nodeId: rootNodeId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: now,
  payload: checkpointScope,
});
if (handoffTurnItem !== null) {
  yield* emitEvent({
    type: "turn-item.updated",
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: handoffTurnItem,
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
const forkResolution = nativeForkResolution ?? portableForkResolution;
if (pendingForkTransfer !== undefined && forkResolution !== null) {
  yield* emitEvent({
    type: "context-transfer.updated",
    threadId: command.threadId,
    runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: {
      ...pendingForkTransfer,
      targetProviderInstanceId: modelSelection.instanceId,
      targetRunId: runId,
      status: "consumed",
      resolution: forkResolution,
      error: null,
      updatedAt: now,
      consumedAt: now,
    },
  });
}

const detachDetail = canResumeAcrossInstances
  ? "Provider account changed; continuing the native thread."
  : "Provider or model selection changed.";
for (const session of sessionsToDetach) {
  yield* emitEvent({
    type: "provider-session.detached",
    threadId: command.threadId,
    driver: session.driver,
    providerInstanceId: session.providerInstanceId,
    occurredAt: now,
    payload: {
      providerSessionId: session.id,
      detachedAt: now,
      reason: detachDetail,
    },
  });
  yield* Ref.update(effects, (existing) => [
    ...existing,
    {
      id: `effect:${command.commandId}:provider-session.detach:${session.id}`,
      commandId: command.commandId,
      threadId: command.threadId,
      request: {
        type: "provider-session.detach",
        providerSessionId: session.id,
        detail: detachDetail,
      },
    } satisfies PendingOrchestrationEffectV2,
  ]);
}
const pendingEffect = {
  id: `effect:${command.commandId}:provider-turn.start:${runId}`,
  commandId: command.commandId,
  threadId: command.threadId,
  request: { type: "provider-turn.start", runId },
} satisfies PendingOrchestrationEffectV2;
yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
});
