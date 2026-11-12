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

export function wakeWorkStartedAt(
  runs: ReadonlyArray<OrchestrationV2Run>,
  trigger: {
    readonly notification?: unknown;
    readonly delegatedCompletion?: unknown;
    readonly restartContinuationOfRunId?: RunId | undefined;
  },
): Pick<OrchestrationV2Run, "workStartedAt"> {
  if (
    trigger.notification === undefined &&
    trigger.delegatedCompletion === undefined &&
    trigger.restartContinuationOfRunId === undefined
  ) {
    return {};
  }
  const previous = runs
    .flatMap((run) => (run.startedAt === null ? [] : [{ run, startedAt: run.startedAt }]))
    .toSorted(
      (left, right) =>
        DateTime.Order(right.startedAt, left.startedAt) || right.run.ordinal - left.run.ordinal,
    )[0]?.run;
  return previous === undefined ? {} : { workStartedAt: orchestrationV2RunWorkStartedAt(previous) };
}

export function commandThreadId(command: OrchestrationV2ServerCommand): ThreadId {
  switch (command.type) {
    case "thread.create":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.delete":
    case "thread.guest-share.open":
    case "thread.guest-share.redeem":
    case "thread.guest-share.close":
    case "thread.guest-message.submit":
    case "thread.guest-message.dismiss":
    case "thread.settle":
    case "thread.auto-settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.auto-settle.set":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.active.reorder":
    case "thread.tag.set":
    case "thread.visit":
    case "thread.mark-unread":
    case "thread.metadata.update":
    case "thread.pull-request.link":
    case "thread.pull-request.unlink":
    case "thread.pull-request-link.sync":
    case "thread.pull-request.watch":
    case "thread.pull-request-watch.sync":
    case "thread.pull-request.sync":
    case "thread.title.regeneration.complete":
    case "thread.project.adopt-folder":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "provider-session.detach":
    case "message.dispatch":
    case "notification.delivery.accept":
    case "prepared-run.release":
    case "prepared-run.progress":
    case "prepared-run.fail":
    case "prepared-run.retry":
    case "subagent.stop":
    case "run.interrupt":
    case "queued-message.promote-to-steer":
    case "queued-run.start":
    case "queue.resume":
    case "queued-run.reorder":
    case "queued-run.cancel":
    case "queued-run.edit":
    case "runtime-request.respond":
    case "runtime-request.delivery.fail":
    case "thread.user-input.dismiss":
    case "checkpoint.rollback":
    case "checkpoint.rollback.fail":
    case "thread.background-work.settle":
    case "thread.interrupt.unresponsive":
    case "thread.stop":
    case "provider.switch":
      return command.threadId;
    case "delegated_task.request":
    case "delegated_task.remote.request":
    case "delegated_task.remote.complete":
    case "delegated_task.remote.stop":
    case "delegated_task.wake-policy":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "thread.created.record":
      return command.parentThreadId;
    case "secret_request.record":
    case "link_request.record":
      return command.threadId;
    case "thread.fork":
    case "thread.merge_back":
      return command.targetThreadId;
  }
}

// Validate before resolving the request: adapters may otherwise coerce unusable answers.

export function legacyPullRequestLink(
  thread: OrchestrationV2AppThread,
  linked: ThreadLinkedPullRequest,
  now: DateTime.Utc,
): ThreadPullRequestLink {
  const key = legacyThreadPullRequestKey(linked);
  const existing = threadPullRequestsOf(thread).find((link) =>
    threadPullRequestKeysEqual(link, key),
  );
  return withPullRequestWatch(
    {
      ...key,
      url: canonicalizeGitCafePullRequestUrl(linked.url),
      source: "manual",
      linkedAt: DateTime.formatIso(now),
      snapshot: null,
      stack: null,
      ...(existing?.repositoryWebUrl !== undefined && {
        repositoryWebUrl: existing.repositoryWebUrl,
      }),
      ...(existing?.endedWatch && { endedWatch: existing.endedWatch }),
    },
    existing?.watch,
  );
}

export function delegatedCompletionWakeDetail(
  taskIds: ReadonlyArray<string>,
  tasks: ReadonlyArray<OrchestrationV2Subagent>,
): string {
  let remainingBytes = DELEGATED_RESULT_INLINE_BYTES;
  return taskIds
    .map((taskId) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      const label = `Delegated task ${taskId}${task?.title == null ? "" : ` (${task.title})`}${task === undefined ? " reached a terminal state" : ` [${task.status}]`}`;
      if (task?.result != null) {
        const detail = `${label}:\n${task.result}`;
        const bytes = Buffer.byteLength(detail);
        if (bytes <= remainingBytes) {
          remainingBytes -= bytes;
          return detail;
        }
      }
      return `${label}. Use task_status with taskId ${taskId} to read the result.`;
    })
    .join("\n\n");
}

export function delegatedTaskTerminalStatus(
  status: OrchestrationV2Run["status"],
): OrchestrationV2Subagent["status"] | null {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    case "rolled_back":
      return "cancelled";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return null;
  }
}

/** Failed worktree setup keeps the queue held so queued messages cannot start in the project checkout. */

export function usageLimitHoldsQueue(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems" | "providerSessions">,
  providerInstanceId: ModelSelection["instanceId"],
): boolean {
  let latestSession: OrchestrationV2ThreadProjection["providerSessions"][number] | undefined;
  for (const session of projection.providerSessions) {
    if (
      session.providerInstanceId === providerInstanceId &&
      (latestSession === undefined ||
        DateTime.isGreaterThan(session.updatedAt, latestSession.updatedAt))
    ) {
      latestSession = session;
    }
  }
  return (
    usageLimitBlockedRun(projection.runs, projection.turnItems, latestSession?.lastError ?? null)
      ?.providerInstanceId === providerInstanceId
  );
}

export function runForSourcePoint(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "checkpoints">,
  sourcePoint: Extract<
    OrchestrationV2Command,
    { readonly type: "thread.fork" | "thread.merge_back" }
  >["sourcePoint"],
): OrchestrationV2Run | null {
  switch (sourcePoint.type) {
    case "latest_stable":
      return latestStableRun(projection);
    case "run":
      return projection.runs.find((run) => run.id === sourcePoint.runId) ?? null;
    case "checkpoint": {
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === sourcePoint.checkpointId,
      );
      return checkpoint?.runId === null || checkpoint === undefined
        ? null
        : (projection.runs.find((run) => run.id === checkpoint.runId) ?? null);
    }
  }
}

export function contextSourcePointForRun(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "providerTurns" | "attempts"
  >,
  run: OrchestrationV2Run,
): OrchestrationV2ContextSourcePoint {
  const providerThread = providerThreadForRun(projection, run);
  const providerTurn = providerTurnForRun(projection, run);
  return {
    threadId: projection.thread.id,
    runId: run.id,
    ...(run.checkpointId === null ? {} : { checkpointId: run.checkpointId }),
    ...(providerThread?.nativeThreadRef === null || providerThread?.nativeThreadRef === undefined
      ? {}
      : { providerThreadRef: providerThread.nativeThreadRef }),
    ...(providerTurn?.nativeTurnRef === null || providerTurn?.nativeTurnRef === undefined
      ? {}
      : { providerTurnRef: providerTurn.nativeTurnRef }),
  };
}

export function withPullRequestWatch(
  link: ThreadPullRequestLink,
  watch: ThreadPullRequestWatch | undefined,
): ThreadPullRequestLink {
  const { watch: previous, endedWatch, ...rest } = link;
  if (watch !== undefined) return { ...rest, watch };
  const ended = previous ?? endedWatch;
  return ended === undefined ? rest : { ...rest, endedWatch: ended };
}

export const DELEGATED_RESULT_INLINE_BYTES = 16_000;

export function latestStableRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | null {
  return (
    projection.runs
      .filter((run) => run.status === "completed" && run.checkpointId !== null)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null
  );
}

export function providerThreadForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads">,
  run: OrchestrationV2Run,
): OrchestrationV2ProviderThread | undefined {
  return run.providerThreadId === null
    ? undefined
    : projection.providerThreads.find((candidate) => candidate.id === run.providerThreadId);
}

export function providerTurnForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "providerTurns" | "attempts">,
  run: OrchestrationV2Run,
): OrchestrationV2ProviderTurn | undefined {
  if (run.activeAttemptId === null) {
    return undefined;
  }

  return (
    latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId) ??
    projection.providerTurns.find((turn) => {
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      return attempt?.providerTurnId === turn.id;
    })
  );
}
