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
import type { MessageDispatchInput, MessageRunIdentity } from "./messageDispatchTypes.ts";
import { startFreshRun } from "./messageFreshRunStart.ts";
import { lastDeliveredRunForProviderThread, latestContextTransfer, nextRunOrdinal, pendingForkTransferForThread, pendingMergeBackTransfersForThread, rootProviderThreadsForProvider, worktreeSetupPending } from "../Orchestrator.ts";

// Extracted from ./messageHandlers to keep that module under 800 lines.

export interface RunHandoffInput extends MessageDispatchInput, MessageRunIdentity {}

export interface ResolveRunHandoffParams {
  deps: MakeMessageHandlersDeps;
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
  input: RunHandoffInput;
}

export const resolveRunHandoff = Effect.fn("messageResolveRunHandoff")(function* (
  params: ResolveRunHandoffParams,
) {
  const { deps, command, events, effects } = params;
  const { activeProviderThread, canResumeAcrossInstances, isProviderSwitch, latestCompletedRun, latestHandoffRun, legacyImportItems, modelSelection, now, ordinal, pendingForkTransfer, pendingMergeBackTransfer, projection, runId } = params.input;

const sourceProjection =
  pendingForkTransfer === undefined
    ? null
    : yield* deps.projectionStore
        .getThreadRecords(pendingForkTransfer.sourceThreadId, [
          "runs",
          "attempts",
          "providerThreads",
          "providerTurns",
        ])
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: pendingForkTransfer.sourceThreadId,
                cause,
              }),
          ),
        );
const sourceRun =
  pendingForkTransfer?.sourcePoint.runId === undefined || sourceProjection === null
    ? null
    : (sourceProjection.runs.find(
        (candidate) => candidate.id === pendingForkTransfer.sourcePoint.runId,
      ) ?? null);
const sourceProviderThread =
  sourceProjection === null || sourceRun === null
    ? undefined
    : providerThreadForRun(sourceProjection, sourceRun);
const sourceProviderTurnId =
  sourceProjection === null || sourceRun === null || sourceRun.activeAttemptId === null
    ? undefined
    : (latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceRun.activeAttemptId)
        ?.id ??
      sourceProjection.attempts.find((candidate) => candidate.id === sourceRun.activeAttemptId)
        ?.providerTurnId ??
      undefined);
const sideChatFork =
  pendingForkTransfer !== undefined && projection.thread.lineage.sideChat === true;
// Opened during the parent's first turn: the digest is the whole context.
const sideChatWithoutSource =
  sideChatFork && pendingForkTransfer.sourcePoint.runId === undefined;
if (pendingForkTransfer !== undefined) {
  if (!sideChatWithoutSource && (sourceRun === null || sourceProviderThread === undefined)) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Pending fork transfer ${pendingForkTransfer.id} has no resolvable source provider thread.`,
    });
  }
  if (pendingForkTransfer.sourceProviderInstanceId === null) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Pending fork transfer ${pendingForkTransfer.id} has no source provider.`,
    });
  }
}

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
const targetProviderThread =
  isProviderSwitch && !canResumeAcrossInstances
    ? rootProviderThreadsForProvider(projection, modelSelection.instanceId)[0]
    : activeProviderThread;
const providerSessionId =
  (canResumeAcrossInstances ? undefined : targetProviderThread?.providerSessionId) ??
  (yield* mapDispatchError(command)(
    deps.providerSessionIdFor({
      adapter,
      providerInstanceId: modelSelection.instanceId,
      threadId: command.threadId,
    }),
  ));
const existingProviderSession = projection.providerSessions.find(
  (candidate) => candidate.id === providerSessionId,
);
const resolvedRuntimePolicy = yield* deps.runtimePolicy
  .resolve({ thread: projection.thread, modelSelection })
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

const capabilities = yield* adapter.getCapabilities().pipe(
  Effect.mapError(
    (cause) =>
      new OrchestratorProviderAdapterError({
        commandId: command.commandId,
        providerInstanceId: modelSelection.instanceId,
        cause,
      }),
  ),
);
const sourceRunsAfterFork =
  sourceProjection === null
    ? []
    : sourceProjection.runs.filter(
        (candidate) => sourceRun === null || candidate.ordinal > sourceRun.ordinal,
      );
const forkExecution =
  pendingForkTransfer === undefined || sourceRun === null
    ? null
    : yield* mapDispatchError(command)(
        deps.commandPolicy.decideForkExecution({
          commandId: command.commandId,
          threadId: command.threadId,
          providerInstanceId: modelSelection.instanceId,
          capabilities,
          sameProvider:
            pendingForkTransfer.sourceProviderInstanceId === modelSelection.instanceId,
          hasStrongNativeSource: sourceProviderThread?.nativeThreadRef?.strength === "strong",
          sourceRunStatus: sourceRun.status,
          fromSpecificTurn: sourceRun !== null,
          sourceBusy: sourceRunsAfterFork.some(isActiveRun),
        }),
      );
const canResolveForkNatively = forkExecution === "native_fork";
const requiresPortableFork = forkExecution === "portable_context";

if (canResolveForkNatively) {
  yield* mapDispatchError(command)(
    deps.commandPolicy.ensureNativeFork({
      commandId: command.commandId,
      threadId: command.threadId,
      providerInstanceId: modelSelection.instanceId,
      capabilities,
      fromSpecificTurn: sourceRun !== null,
    }),
  );
}

  const ensuredProviderThread: OrchestrationV2ProviderThread =
  targetProviderThread === undefined
    ? {
        id: deps.idAllocator.derive.providerThread({
          driver: adapter.driver,
          nativeThreadId: `pending:${runId}`,
        }),
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
        handoffIds: [],
        forkedFrom:
          canResolveForkNatively && sourceProviderThread !== undefined
            ? {
                providerThreadId: sourceProviderThread.id,
                ...(sourceProviderTurnId === undefined
                  ? {}
                  : { providerTurnId: sourceProviderTurnId }),
              }
            : null,
        createdAt: now,
        updatedAt: now,
      }
    : {
        ...(targetProviderThread as OrchestrationV2ProviderThread),
        providerInstanceId: modelSelection.instanceId,
        providerSessionId,
        updatedAt: now,
      };
const portableForkItems =
  !requiresPortableFork || sourceProjection === null || sourceRun === null
    ? []
    : yield* readForkHistoryItems(deps.projectionStore, sourceProjection, sourceRun).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({ threadId: sourceProjection.thread.id, cause }),
        ),
      );
const portableForkHandoff =
  !requiresPortableFork ||
  pendingForkTransfer === undefined ||
  sourceProjection === null ||
  sourceRun === null
    ? null
    : yield* deps.contextHandoffService
        .prepareProviderHandoff({
          threadId: command.threadId,
          targetRunId: runId,
          transferId: pendingForkTransfer.id,
          fromProviderThreadIds:
            sourceProviderThread === undefined ? [] : [sourceProviderThread.id],
          toProviderThreadId: ensuredProviderThread.id,
          fromProviderInstanceId: sourceRun.providerInstanceId,
          toProviderInstanceId: modelSelection.instanceId,
          coveredRunOrdinals: visibleDeltaRunOrdinals(sourceProjection, portableForkItems),
          strategy: "full_thread_summary",
          items: portableForkItems,
          runs: sourceProjection.runs,
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
// Without a source run the digest covers the parent's whole history: inherited fork rows
// first, so the cap truncates them first, then imported and run items.
const sideChatParentRunIds = [
  // Queued messages have not reached the main thread yet.
  ...sourceRunsAfterFork.filter((run) => run.status !== "queued").map((run) => run.id),
  ...(sourceRun === null && sourceProjection?.thread.historyOrigin === "v1_import"
    ? [null]
    : []),
];
const sideChatParentItems =
  !sideChatFork || sourceProjection === null
    ? []
    : [
        ...(sideChatWithoutSource ? yield* deps.readInheritedItems(sourceProjection.thread) : []),
        ...(sideChatParentRunIds.length === 0
          ? []
          : visibleConversationItems(
              sourceProjection,
              yield* deps.readHandoffItems(sourceProjection.thread.id, sideChatParentRunIds),
            )),
      ];
// The framing note goes in even when the parent has no activity after the fork point.
const sideChatContextHandoff =
  !sideChatFork || pendingForkTransfer === undefined || sourceProjection === null
    ? null
    : yield* deps.contextHandoffService
        .prepareSideChatContext({
          threadId: command.threadId,
          parentThreadId: sourceProjection.thread.id,
          targetRunId: runId,
          transferId: pendingForkTransfer.id,
          toProviderThreadId: ensuredProviderThread.id,
          fromProviderInstanceId:
            pendingForkTransfer.sourceProviderInstanceId ?? modelSelection.instanceId,
          toProviderInstanceId: modelSelection.instanceId,
          coveredRunOrdinals: visibleDeltaRunOrdinals(sourceProjection, sideChatParentItems),
          parentItems: sideChatParentItems,
          createdAt: now,
        })
        .pipe(mapDispatchError(command));
const requiresFullProviderSwitchContext =
  isProviderSwitch && pendingMergeBackTransfer !== undefined;
const targetLastCompletedRun =
  targetProviderThread === undefined
    ? undefined
    : lastDeliveredRunForProviderThread(projection, targetProviderThread.id);
const providerSwitchCoveredRuns =
  !isProviderSwitch || canResumeAcrossInstances || latestHandoffRun === undefined
    ? []
    : projection.runs.filter(
        (run) =>
          isHandoffSourceRun(run) &&
          run.ordinal >
            (requiresFullProviderSwitchContext ? 0 : (targetLastCompletedRun?.ordinal ?? 0)) &&
          run.ordinal <= latestHandoffRun.ordinal,
      );
const providerSwitchItems =
  providerSwitchCoveredRuns.length === 0
    ? []
    : [
        ...(latestCompletedRun !== undefined &&
        (targetProviderThread === undefined || requiresFullProviderSwitchContext)
          ? legacyImportItems
          : []),
        ...(yield* deps.readHandoffItems(
          command.threadId,
          providerSwitchCoveredRuns.map((run) => run.id),
        )),
      ];
const providerSwitchTransferId =
  providerSwitchCoveredRuns.length === 0 || latestHandoffRun === undefined
    ? null
    : yield* mapDispatchError(command)(
        deps.idAllocator.allocate.contextTransfer({
          sourceThreadId: command.threadId,
          targetThreadId: command.threadId,
          type: "provider_handoff",
        }),
      );
if (providerSwitchTransferId !== null) {
  yield* mapDispatchError(command)(
    deps.commandPolicy.ensureContextHandoff({
      commandId: command.commandId,
      threadId: command.threadId,
      providerInstanceId: modelSelection.instanceId,
      capabilities,
      strategy:
        targetProviderThread === undefined || requiresFullProviderSwitchContext
          ? "full_thread_summary"
          : "delta_context",
    }),
  );
}
const providerSwitchHandoff =
  providerSwitchTransferId === null || latestHandoffRun === undefined
    ? null
    : yield* deps.contextHandoffService
        .prepareProviderHandoff({
          threadId: command.threadId,
          targetRunId: runId,
          transferId: providerSwitchTransferId,
          fromProviderThreadIds: Array.from(
            new Set(
              providerSwitchCoveredRuns.flatMap((run) =>
                run.providerThreadId === null ? [] : [run.providerThreadId],
              ),
            ),
          ),
          toProviderThreadId: ensuredProviderThread.id,
          fromProviderInstanceId: latestHandoffRun.providerInstanceId,
          toProviderInstanceId: modelSelection.instanceId,
          coveredRunOrdinals: {
            from: providerSwitchCoveredRuns[0]!.ordinal,
            to: providerSwitchCoveredRuns.at(-1)!.ordinal,
          },
          strategy:
            targetProviderThread === undefined || requiresFullProviderSwitchContext
              ? "full_thread_summary"
              : "delta_since_target_last_seen",
          items: providerSwitchItems,
          runs: projection.runs,
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
const legacyImportRecoveryHandoff =
  isProviderSwitch &&
  !canResumeAcrossInstances &&
  latestCompletedRun === undefined &&
  legacyImportItems.length > 0
    ? yield* deps.contextHandoffService
        .prepareLegacyImport({
          threadId: command.threadId,
          targetRunId: runId,
          toProviderThreadId: ensuredProviderThread.id,
          toProviderInstanceId: modelSelection.instanceId,
          items: legacyImportItems,
          createdAt: now,
        })
        .pipe(mapDispatchError(command))
    : null;

  return {
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
  };
});
