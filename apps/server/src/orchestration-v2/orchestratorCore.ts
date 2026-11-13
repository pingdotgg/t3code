import type {
  GuestShareId,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  runRanAfter,
  usageLimitBlockedRun,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-definitions/registry";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
  threadPullRequestKeysEqual,
  legacyThreadPullRequestKey,
} from "../sourceControl/threadPullRequests.ts";
import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type ChatAttachment,
  CommandId,
  type GuestMessageId,
  isCompactionCommandMessage,
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  MessageId,
  type NodeId,
  type ModelSelection,
  OrchestrationV2Command,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2LimitRecoveryUpdate,
  type OrchestrationV2ServerCommand,
  type ThreadPullRequestLink,
  type ThreadPullRequestWatch,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ContextSourcePoint,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ContextTransferResolution,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DelegatedCompletionCohort,
  type OrchestrationV2DelegatedCompletionDelivery,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2ModelSwitch,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  latestProviderTurnForAttempt,
  parseGoalCommand,
  orchestrationV2RunWorkStartedAt,
  orchestrationV2WorktreePending,
  ProviderInstanceId,
  ProviderInteractionMode,
  isRuntimeModeAbove,
  resolveProviderInstanceEnabled,
  resolveProjectProviderInstanceEnabled,
  type ProviderSessionId,
  RunId,
  RuntimeMode,
  ThreadLinkedPullRequest,
  ThreadId,
  TurnItemId,
  TrimmedNonEmptyString,
  managedRuntimeModeCeilingMessage,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { modelSwitchSince } from "./modelSwitch.ts";
import { recordThreadOpen } from "@t3tools/shared/paletteSearch";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
  pendingBackgroundTurnItems,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProjectStore from "./ProjectStore.ts";
import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import {
  CommandPolicyV2,
  goalCommandStopsActiveRun,
  isActiveRun,
  isNativeMaintenanceCommand,
  resolveMessageDispatchIntent,
} from "./CommandPolicy.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import {
  ContextHandoffServiceV2,
  readForkHistoryItems,
  readInheritedHandoffItems,
  visibleConversationItems,
  visibleDeltaRunOrdinals,
} from "./ContextHandoffService.ts";
import { notificationTurnItem } from "@t3tools/provider-core/server/notification";
import {
  cancelledBeforeStart,
  continuationFailedBeforePrompt,
  continuationStartRetryDelayMs,
  isRestartContinuationSource,
  runOutcome,
} from "./RestartBackgroundNote.ts";
import {
  isBufferedProviderNotification,
  isUndeliveredMailboxSteer,
} from "./NotificationMailbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import {
  decideGuestMessageSend,
  guestShareAfterCancelledSend,
  releasedGuestAttachmentIds,
  withoutGuestAttribution,
  decideGuestShareCommand,
  type GuestShareCommand,
} from "./GuestShareDecider.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { withCommandMetrics } from "../observability/Metrics.ts";
import type { OrchestrationEffectRequestV2, PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeCheckpointHandlers } from "./handlers/checkpointHandlers.ts";
import { makeLifecycleHandlers } from "./handlers/lifecycleHandlers.ts";
import { makeMessageHandlers } from "./handlers/messageHandlers.ts";
import { makeQueueHandlers } from "./handlers/queueHandlers.ts";
import {
  RUNTIME_REQUEST_DELIVERY_FAILED_MESSAGE,
  WORKSPACE_PREPARATION_INPUT,
} from "./orchestrationMessages.ts";
import { makeEventEmitter, mapDispatchError } from "./orchestrationEmitters.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
  narrowToCeiling,
  type RuntimeModeCeiling,
  runtimeModeCeilingRefusal,
  threadsStartingWork,
} from "./DispatchModeLimit.ts";
import {
  applyToProjection,
  emptyProjection,
  threadShellFromProjection,
  ProjectionStoreV2,
  type ProjectionRecordField,
  type ProjectionTimelinePage,
  type ProjectionTimelinePageOptions,
  type ProjectionRecordFilter,
  type ProjectionRecords,
  type ProjectionCheckpointContext,
  type OlderSettledThreadsListing,
  type ActiveShellIndexEntry,
  type OlderSettledThreadsQuery,
  type ShellSnapshotOptions,
} from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "./ProviderSwitchService.ts";
import { isAutomaticCompletionRun, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";
import { isRuntimePolicyAboveCeilingError, RuntimePolicyV2 } from "./RuntimePolicy.ts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
  makeSubagentChildThread,
  subagentResultForRun,
  delegatedTaskProgress,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  forkableSourceRunStatusError,
  isForkableSourceRunStatus,
  ThreadForkServiceV2,
} from "./ThreadForkService.ts";
import { planThreadDeletion } from "./ThreadDeletion.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../serverSettings.ts";
import {
  OrchestratorDispatchError,
  OrchestratorThreadAlreadyExistsError,
  OrchestratorCommandRejectedError,
  OrchestratorProjectionError,
  isOrchestratorProjectionError,
  OrchestratorDomainEventStreamError,
  OrchestratorProviderAdapterError,
  OrchestratorSubagentThreadReadOnlyError,
  OrchestratorThreadAboveModeLimitError,
} from "./orchestrationErrors.ts";
import {
  wakeWorkStartedAt,
  commandThreadId,
  legacyPullRequestLink,
  delegatedCompletionWakeDetail,
  delegatedTaskTerminalStatus,
  usageLimitHoldsQueue,
  runForSourcePoint,
  contextSourcePointForRun,
  withPullRequestWatch,
  latestStableRun,
  providerThreadForRun,
  providerTurnForRun,
  DELEGATED_RESULT_INLINE_BYTES,
} from "./orchestrationCommandQueries.ts";


export * from "./OrchestratorCorePrelude/OrchestratorV2Shape.ts";

import { type OrchestratorV2Shape } from "./OrchestratorCorePrelude/OrchestratorV2Shape.ts";
import { installFailQueuedRunStart } from "./OrchestratorCoreParts/FailQueuedRunStart.ts";
import { installStartNextQueuedRun } from "./OrchestratorCoreParts/StartNextQueuedRun.ts";
import { installDispatchDelegatedTaskCompletionDeliveryResolution } from "./OrchestratorCoreParts/DispatchDelegatedTaskCompletionDeliveryResolution.ts";
import { installRecordSubagentFollowup } from "./OrchestratorCoreParts/RecordSubagentFollowup.ts";
import { installDispatchSteerIntoRun } from "./OrchestratorCoreParts/DispatchSteerIntoRun.ts";
import { installSettleInterruptedRun } from "./OrchestratorCoreParts/SettleInterruptedRun.ts";
import { installSettleBackgroundWork } from "./OrchestratorCoreParts/SettleBackgroundWork.ts";
import { installDispatchRunInterrupt } from "./OrchestratorCoreParts/DispatchRunInterrupt.ts";
import { installDispatchRuntimeRequestRespond } from "./OrchestratorCoreParts/DispatchRuntimeRequestRespond.ts";
import { installDispatchThreadMergeBack } from "./OrchestratorCoreParts/DispatchThreadMergeBack.ts";
import { installDispatchDelegatedTaskRequest } from "./OrchestratorCoreParts/DispatchDelegatedTaskRequest.ts";
import { installDispatchRemoteDelegatedTaskComplete } from "./OrchestratorCoreParts/DispatchRemoteDelegatedTaskComplete.ts";
import { installDispatchSubagentStop } from "./OrchestratorCoreParts/DispatchSubagentStop.ts";
import { installFinalizeAppOwnedSubagentTask } from "./OrchestratorCoreParts/FinalizeAppOwnedSubagentTask.ts";
import { installDispatchOnce } from "./OrchestratorCoreParts/DispatchOnce.ts";
import { installDispatchWithReceiptEffect } from "./OrchestratorCoreParts/DispatchWithReceiptEffect.ts";
import { installRecoverDelegatedTasks } from "./OrchestratorCoreParts/RecoverDelegatedTasks.ts";

export class OrchestratorV2 extends Context.Service<OrchestratorV2, OrchestratorV2Shape>()(
  "t3/orchestration-v2/orchestratorCore/OrchestratorV2",
) {}

export const makeOrchestratorCore = Effect.fn("orchestrationV2.Orchestrator.layer")(
  function* () {
      const FailQueuedRunStart = yield* installFailQueuedRunStart({});
      const StartNextQueuedRun = yield* installStartNextQueuedRun({ ...FailQueuedRunStart });
      const DispatchDelegatedTaskCompletionDeliveryResolution = yield* installDispatchDelegatedTaskCompletionDeliveryResolution({ ...FailQueuedRunStart, ...StartNextQueuedRun });
      const RecordSubagentFollowup = yield* installRecordSubagentFollowup({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution });
      const DispatchSteerIntoRun = yield* installDispatchSteerIntoRun({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup });
      const SettleInterruptedRun = yield* installSettleInterruptedRun({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun });
      const SettleBackgroundWork = yield* installSettleBackgroundWork({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun });
      const DispatchRunInterrupt = yield* installDispatchRunInterrupt({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun, ...SettleBackgroundWork });
      const DispatchRuntimeRequestRespond = yield* installDispatchRuntimeRequestRespond({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun, ...SettleBackgroundWork, ...DispatchRunInterrupt });
      const DispatchThreadMergeBack = yield* installDispatchThreadMergeBack({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun, ...SettleBackgroundWork, ...DispatchRunInterrupt, ...DispatchRuntimeRequestRespond });
      const DispatchDelegatedTaskRequest = yield* installDispatchDelegatedTaskRequest({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun, ...SettleBackgroundWork, ...DispatchRunInterrupt, ...DispatchRuntimeRequestRespond, ...DispatchThreadMergeBack });
      const DispatchRemoteDelegatedTaskComplete = yield* installDispatchRemoteDelegatedTaskComplete({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun, ...SettleBackgroundWork, ...DispatchRunInterrupt, ...DispatchRuntimeRequestRespond, ...DispatchThreadMergeBack, ...DispatchDelegatedTaskRequest });
      const DispatchSubagentStop = yield* installDispatchSubagentStop({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun, ...SettleBackgroundWork, ...DispatchRunInterrupt, ...DispatchRuntimeRequestRespond, ...DispatchThreadMergeBack, ...DispatchDelegatedTaskRequest, ...DispatchRemoteDelegatedTaskComplete });
      const FinalizeAppOwnedSubagentTask = yield* installFinalizeAppOwnedSubagentTask({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun, ...SettleBackgroundWork, ...DispatchRunInterrupt, ...DispatchRuntimeRequestRespond, ...DispatchThreadMergeBack, ...DispatchDelegatedTaskRequest, ...DispatchRemoteDelegatedTaskComplete, ...DispatchSubagentStop });
      const DispatchOnce = yield* installDispatchOnce({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun, ...SettleBackgroundWork, ...DispatchRunInterrupt, ...DispatchRuntimeRequestRespond, ...DispatchThreadMergeBack, ...DispatchDelegatedTaskRequest, ...DispatchRemoteDelegatedTaskComplete, ...DispatchSubagentStop, ...FinalizeAppOwnedSubagentTask });
      const DispatchWithReceiptEffect = yield* installDispatchWithReceiptEffect({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun, ...SettleBackgroundWork, ...DispatchRunInterrupt, ...DispatchRuntimeRequestRespond, ...DispatchThreadMergeBack, ...DispatchDelegatedTaskRequest, ...DispatchRemoteDelegatedTaskComplete, ...DispatchSubagentStop, ...FinalizeAppOwnedSubagentTask, ...DispatchOnce });
      const RecoverDelegatedTasks = yield* installRecoverDelegatedTasks({ ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun, ...SettleBackgroundWork, ...DispatchRunInterrupt, ...DispatchRuntimeRequestRespond, ...DispatchThreadMergeBack, ...DispatchDelegatedTaskRequest, ...DispatchRemoteDelegatedTaskComplete, ...DispatchSubagentStop, ...FinalizeAppOwnedSubagentTask, ...DispatchOnce, ...DispatchWithReceiptEffect });
      const { awaitsRestartContinuation, delegatedTaskResultPending, dispatchWithReceipt, dispatchWithReceiptEffect, effectOutbox, eventSink, projectionStore, recoverDelegatedTask, recoverDelegatedTasks, resumeQueuedRuns, shellProjectionError, stopReachedRun, threadDispatch } = { ...FailQueuedRunStart, ...StartNextQueuedRun, ...DispatchDelegatedTaskCompletionDeliveryResolution, ...RecordSubagentFollowup, ...DispatchSteerIntoRun, ...SettleInterruptedRun, ...SettleBackgroundWork, ...DispatchRunInterrupt, ...DispatchRuntimeRequestRespond, ...DispatchThreadMergeBack, ...DispatchDelegatedTaskRequest, ...DispatchRemoteDelegatedTaskComplete, ...DispatchSubagentStop, ...FinalizeAppOwnedSubagentTask, ...DispatchOnce, ...DispatchWithReceiptEffect, ...RecoverDelegatedTasks };
return OrchestratorV2.of({
    resumeQueuedRuns,
    recoverDelegatedTasks,
    recoverDelegatedTask,
    delegatedTaskResultPending,
    restartContinuationPending: Effect.fn("OrchestratorV2.restartContinuationPending")(
      function (run) {
        return awaitsRestartContinuation(run).pipe(Effect.orElseSucceed(() => false));
      },
    ),
    awaitRestartContinuation: Effect.fn("OrchestratorV2.awaitRestartContinuation")(function (run) {
      return effectOutbox.awaitSettled(`effect:restart-continuation:${run.id}`).pipe(Effect.ignore);
    }),
    dispatch: dispatchWithReceipt,
    autoArmLimitRecovery: Effect.fn("OrchestratorV2.autoArmLimitRecovery")(function (input) {
      return threadDispatch.withLock(
        input.threadId,
        Effect.gen(function* () {
          const thread = yield* projectionStore
            .getThread(input.threadId)
            .pipe(
              Effect.mapError(
                (cause) => new OrchestratorProjectionError({ threadId: input.threadId, cause }),
              ),
            );
          // Stop or an explicit recovery choice can commit after the sweep reads its candidate.
          if (
            thread.limitRecovery?.runId === input.limitRecovery.runId &&
            thread.limitRecovery.resetAt === input.limitRecovery.resetAt
          )
            return;
          const command = { type: "thread.metadata.update", ...input } as const;
          // A Stop that reached the run before its limit failure landed had nothing to disarm.
          const stopped = yield* stopReachedRun(command, input.threadId, input.limitRecovery.runId);
          yield* dispatchWithReceiptEffect(
            stopped
              ? {
                  ...command,
                  limitRecovery: { ...input.limitRecovery, autoResume: false, snooze: false },
                }
              : command,
          );
        }),
      );
    }),
    searchThreadStream: (input) =>
      projectionStore
        .searchThreadStream(input)
        .pipe(
          Stream.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: input.threadId, cause }),
          ),
        ),
    searchThread: Effect.fn("OrchestratorV2.searchThread")(function (input) {
      return projectionStore
        .searchThread(input)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: input.threadId, cause }),
          ),
        );
    }),
    getThreadHistoryPage: Effect.fn("OrchestratorV2.getThreadHistoryPage")(
      function (threadId, cursor, throughEntryId, conversationOnly, workMode) {
        return projectionStore
          .getThreadHistoryPage(threadId, cursor, throughEntryId, conversationOnly, workMode)
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      },
    ),
    getTimelinePage: Effect.fn("OrchestratorV2.getTimelinePage")(function (threadId, options) {
      return projectionStore
        .getTimelinePage(threadId, options)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getMessageCount: Effect.fn("OrchestratorV2.getMessageCount")(function (threadId) {
      return projectionStore
        .getMessageCount(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getTurnItem: Effect.fn("OrchestratorV2.getTurnItem")(function (input) {
      return projectionStore
        .getTurnItem(input)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: input.threadId, cause }),
          ),
        );
    }),
    getThreadRecords: Effect.fn("OrchestratorV2.getThreadRecords")(
      function (threadId, fields, filter) {
        return projectionStore
          .getThreadRecords(threadId, fields, filter)
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      },
    ),
    listAppOwnedChildThreadIds: Effect.fn("OrchestratorV2.listAppOwnedChildThreadIds")(
      function (threadId) {
        return projectionStore
          .listAppOwnedChildThreadIds(threadId)
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      },
    ),
    getThreadProjection: Effect.fn("OrchestratorV2.getThreadProjection")(function (threadId) {
      return projectionStore
        .getThreadProjection(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getCheckpointContext: Effect.fn("OrchestratorV2.getCheckpointContext")(function (threadId) {
      return projectionStore
        .getCheckpointContext(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getThreadSnapshot: Effect.fn("OrchestratorV2.getThreadSnapshot")(function (threadId) {
      return projectionStore
        .getThreadSnapshot(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    getThreadSnapshotWindow: Effect.fn("OrchestratorV2.getThreadSnapshotWindow")(
      function (threadId, options) {
        return projectionStore
          .getThreadSnapshotWindow(threadId, options)
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      },
    ),
    getPullRequestSnapshot: Effect.fn("OrchestratorV2.getPullRequestSnapshot")(function (options) {
      return projectionStore
        .getPullRequestSnapshot(options)
        .pipe(Effect.mapError(shellProjectionError));
    }),
    getShellSnapshot: Effect.fn("OrchestratorV2.getShellSnapshot")(function (options) {
      return projectionStore.getShellSnapshot(options).pipe(Effect.mapError(shellProjectionError));
    }),
    listActiveSubagentThreadIds: Effect.fn("OrchestratorV2.listActiveSubagentThreadIds")(
      function () {
        return projectionStore
          .listActiveSubagentThreadIds()
          .pipe(Effect.mapError(shellProjectionError));
      },
    ),
    countThreads: Effect.fn("OrchestratorV2.countThreads")(function () {
      return projectionStore.countThreads().pipe(Effect.mapError(shellProjectionError));
    }),
    listActiveShellIndex: Effect.fn("OrchestratorV2.listActiveShellIndex")(function () {
      return projectionStore.listActiveShellIndex().pipe(Effect.mapError(shellProjectionError));
    }),
    listOlderSettledThreads: Effect.fn("OrchestratorV2.listOlderSettledThreads")(function (query) {
      return projectionStore
        .listOlderSettledThreads(query)
        .pipe(Effect.mapError(shellProjectionError));
    }),
    readShellSnapshot: Effect.fn("OrchestratorV2.readShellSnapshot")(function (options) {
      return projectionStore
        .readShellSnapshot(options)
        .pipe(
          Effect.mapError(shellProjectionError),
          Effect.map(Effect.mapError(shellProjectionError)),
        );
    }),
    getThreadShell: Effect.fn("OrchestratorV2.getThreadShell")(function (threadId) {
      return projectionStore
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    findGuestShareThreadId: Effect.fn("OrchestratorV2.findGuestShareThreadId")(function (shareId) {
      return projectionStore
        .findGuestShareThreadId(shareId)
        .pipe(Effect.mapError(shellProjectionError));
    }),
    getThreadEventSequence: Effect.fn("OrchestratorV2.getThreadEventSequence")(function (threadId) {
      return eventSink
        .latestSequence({ threadId })
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    }),
    streamStoredEvents: eventSink.stream().pipe(
      Stream.mapError(
        (cause) =>
          new OrchestratorDomainEventStreamError({
            cause,
          }),
      ),
    ),
    streamStoredEventsFrom: (input) =>
      eventSink.stream({ ...input, bounded: true }).pipe(
        Stream.mapError(
          (cause) =>
            new OrchestratorDomainEventStreamError({
              cause,
            }),
        ),
      ),
    // Start at the latest sequence; awareness needs no historical replay.
    streamDomainEvents: Stream.unwrap(
      eventSink
        .latestSequence()
        .pipe(Effect.map((latest) => eventSink.stream({ afterSequence: latest }))),
    ).pipe(
      Stream.map((stored) => stored.event),
      Stream.mapError(
        (cause) =>
          new OrchestratorDomainEventStreamError({
            cause,
          }),
      ),
    ),
  });
    },
);
