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
import { startFreshRun } from "./messageFreshRunStart.ts";
import { lastDeliveredRunForProviderThread, latestContextTransfer, nextRunOrdinal, pendingForkTransferForThread, pendingMergeBackTransfersForThread, rootProviderThreadsForProvider, worktreeSetupPending } from "../Orchestrator.ts";

// Extracted from ./messageHandlers to keep that module under 800 lines.
import type { MessageDispatchInput, MessageRunIdentity, RunHandoffResult } from "./messageDispatchTypes.ts";

export interface ProviderThreadInput extends MessageDispatchInput, MessageRunIdentity, RunHandoffResult {}

export interface PrepareProviderThreadParams {
  deps: MakeMessageHandlersDeps;
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
  input: ProviderThreadInput;
}

export const prepareProviderThread = Effect.fn("messagePrepareProviderThread")(function* (
  params: PrepareProviderThreadParams,
) {
  const { deps, command, events, effects } = params;
  const { modelSelection, now, ordinal, pendingMergeBackTransfer, projection, runId } = params.input;
  const {
    canResolveForkNatively,
    capabilities,
    ensuredProviderThread,
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
  } = params.input;

const providerThread: OrchestrationV2ProviderThread = {
  ...ensuredProviderThread,
  status: "active",
  firstRunOrdinal: ensuredProviderThread.firstRunOrdinal ?? ordinal,
  lastRunOrdinal: ordinal,
  handoffIds: [
    ...ensuredProviderThread.handoffIds,
    ...[
      portableForkHandoff,
      sideChatContextHandoff,
      providerSwitchHandoff,
      legacyImportRecoveryHandoff,
    ].flatMap((handoff) => (handoff === null ? [] : [handoff.id])),
  ],
  updatedAt: now,
};

const attemptId = deps.idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
const rootNodeId = deps.idAllocator.derive.rootNode({ runId });
const emitEvent = deps.emit(events, command);
const mergeBackSourceProjection =
  pendingMergeBackTransfer === undefined
    ? null
    : yield* deps.projectionStore
        .getThreadRecords(pendingMergeBackTransfer.sourceThreadId, [
          "runs",
          "attempts",
          "providerThreads",
          "providerTurns",
        ])
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: pendingMergeBackTransfer.sourceThreadId,
                cause,
              }),
          ),
        );
const mergeBackSourceRun =
  pendingMergeBackTransfer?.sourcePoint.runId === undefined ||
  mergeBackSourceProjection === null
    ? null
    : (mergeBackSourceProjection.runs.find(
        (candidate) => candidate.id === pendingMergeBackTransfer.sourcePoint.runId,
      ) ?? null);
if (pendingMergeBackTransfer !== undefined && mergeBackSourceRun === null) {
  return yield* new OrchestratorDispatchError({
    commandId: command.commandId,
    commandType: command.type,
    cause: `Pending merge-back transfer ${pendingMergeBackTransfer.id} has no resolvable source run.`,
  });
}
const mergeBackSourceProviderThread =
  mergeBackSourceProjection === null || mergeBackSourceRun === null
    ? undefined
    : providerThreadForRun(mergeBackSourceProjection, mergeBackSourceRun);
if (pendingMergeBackTransfer !== undefined && mergeBackSourceProviderThread === undefined) {
  return yield* new OrchestratorDispatchError({
    commandId: command.commandId,
    commandType: command.type,
    cause: `Pending merge-back transfer ${pendingMergeBackTransfer.id} has no resolvable source provider thread.`,
  });
}
if (pendingMergeBackTransfer !== undefined) {
  yield* mapDispatchError(command)(
    deps.commandPolicy.ensureContextHandoff({
      commandId: command.commandId,
      threadId: command.threadId,
      providerInstanceId: modelSelection.instanceId,
      capabilities,
      strategy: "fork_delta_context",
    }),
  );
}
const mergeBackDeltaItems =
  mergeBackSourceProjection === null || mergeBackSourceRun === null
    ? []
    : visibleConversationItems(
        mergeBackSourceProjection,
        yield* deps.readHandoffItems(
          mergeBackSourceProjection.thread.id,
          mergeBackSourceProjection.runs
            .filter((run) => run.ordinal <= mergeBackSourceRun.ordinal)
            .map((run) => run.id),
        ),
      );
const mergeBackHandoff =
  pendingMergeBackTransfer === undefined ||
  mergeBackSourceProjection === null ||
  mergeBackSourceRun === null ||
  mergeBackSourceProviderThread === undefined
    ? null
    : yield* deps.contextHandoffService
        .prepareForkDelta({
          sourceThreadId: pendingMergeBackTransfer.sourceThreadId,
          targetThreadId: command.threadId,
          targetRunId: runId,
          transferId: pendingMergeBackTransfer.id,
          fromProviderThreadIds: [mergeBackSourceProviderThread.id],
          toProviderThreadId: providerThread.id,
          fromProviderInstanceId: mergeBackSourceRun.providerInstanceId,
          toProviderInstanceId: modelSelection.instanceId,
          coveredRunOrdinals: visibleDeltaRunOrdinals(
            mergeBackSourceProjection,
            mergeBackDeltaItems,
          ),
          deltaItems: mergeBackDeltaItems,
          createdAt: now,
        })
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
const checkpointScope = yield* deps.checkpointService
  .prepareRootRunScope({
    threadId: command.threadId,
    runId,
    rootNodeId,
    providerThreadId: providerThread.id,
    cwd:
      resolvedRuntimePolicy.cwd ??
      existingProviderSession?.cwd ??
      projection.thread.worktreePath ??
      process.cwd(),
    createdAt: now,
  })
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

  return {
    attemptId,
    checkpointScope,
    emitEvent,
    mergeBackHandoff,
    mergeBackSourceRun,
    providerThread,
    rootNodeId,
  };
});
