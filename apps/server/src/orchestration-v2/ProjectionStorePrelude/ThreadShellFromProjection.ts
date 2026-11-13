import { pendingGuestMessageCount } from "@t3tools/contracts";
import { latestRootProviderFailure, latestUnheldRun, threadErrorSummary, usageLimitRunPresentedAsLatest } from "@t3tools/shared/orchestrationV2ThreadError";
import { threadPullRequestsOf } from "../../sourceControl/threadPullRequests.ts";
import type { OrchestrationV2PendingRuntimeRequestSummary, OrchestrationV2ShellThreadStatus, OrchestrationV2ThreadShell, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { idleCompactionOf, orchestrationV2RunWorkStartedAt, RunId, ThreadId } from "@t3tools/contracts";
import { deriveBlockedOnThreadWait, derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import { ProjectionStoreApplyEventError, ProjectionStoreSetupError, ProjectionStoreThreadNotFoundError, ProjectionStoreReadError, decodeCheckpointContext, RollbackTargetAttempts, decodeRollbackTargetAttempts, inheritsForkConversation, PullRequestThread, type ProjectionStoreV2Error, type ProjectionRecoveryKind, type ProjectionLimitRecoveryCandidate, type ProjectionThreadPullRequests, type ProjectionSettlementCandidate, type ProjectionCheckpointContext, type ProjectionCheckpointCaptureContext, type ProjectionCheckpointRollbackContext, type ProjectionProviderControlContext, type ProjectionProviderControlTarget, type ProjectionRuntimeRecoveryState, type ProjectionPendingUserInputs, type ProjectionThreadProviderContext, type ProjectionRuntimeResponseContext, type ProjectionRecordFilter, type ProjectionRecordField, type ProjectionRecords, type ProjectionTimelinePageOptions, type ProjectionTimelinePage, type ShellSnapshotOptions, type ActiveShellIndexEntry, type OlderSettledThreadsQuery, type OlderSettledThreadsListing } from "./ProjectionSettlementCandidate.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION, upsertById, upsertProviderTurn, preserveRunRecordedFields, preserveCompletionDelivery, emptyProjection, isQueuedProviderThreadPlaceholder, applyToProjection, activeLocalTurnItems, localVisibleTurnItems, withLocalVisibleTurnItems, type ProjectionStoreV2Shape, type ProjectionWindow, type PayloadRow, type ShellPendingTurnItemRow } from "./ProjectionStoreV2Shape.ts";
import { encodeTimelineSources, encodeIdList, matchesNothing, encodeThreadPayload, encodeThreadUpdatedAt, encodeRunPayload, encodeRestartCancelledBackgroundWork, encodeRunAttemptPayload, encodeNodePayload, encodeSubagentPayload, encodeProviderSessionPayload, encodeProviderThreadPayload, encodeProviderTurnPayload, encodeRuntimeRequestPayload, encodeMessagePayload, encodePlanPayload, encodeTurnItemPayload, encodePayloadTimestamp, encodeCheckpointScopePayload, encodeCheckpointPayload, encodeContextHandoffPayload, encodeContextTransferPayload, decodePullRequestThread, decodeThreadPayload, decodeRunPayload, decodeRunAttemptPayload, decodeNodePayload, decodeSubagentPayload, decodeProviderSessionPayload, decodeProviderThreadPayload, decodeProviderTurnPayload, decodeRuntimeRequestPayload, decodeMessagePayload, decodePlanJson, decodeTurnItemPayload, decodeCheckpointScopePayload, decodeCheckpointPayload, decodeContextHandoffPayload, decodeContextTransferPayload, isProjectionStoreThreadNotFoundError, isProjectionStoreReadError, parseEncodedPayload, stringField, nullableStringField, booleanInt, decodeRows, messageIdForTurnItem, sortMessagesByTurnItemOrder, inheritedVisibleTurnItemsFromLocalItems, renumberVisibleTurnItems, makeForkMarkerTurnItem, isTurnItemAtOrBeforeRun, visibleTurnItemsThroughRun, inheritedRunFork, buildVisibleTurnItems, pendingRuntimeRequestSummary, secretRequestAsPendingInput, waitsOnUser, linkCardStillAsks, providerInstanceHistoryForShell, activeProviderGoalForShell, isSilentRunForShell, isInterruptibleRunForShell, isActivityRunForShell, type ShellThreadRow, type ShellRunRow, type SettlementThreadRow, type ShellRunItemCountRow, type ShellItemCountRow, type ShellActivityRunStatus } from "./BuildVisibleTurnItems.ts";

export function threadShellFromProjection(
projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadShell {
const providerSession =
  projection.providerSessions
    .filter((session) => session.providerInstanceId === projection.thread.providerInstanceId)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    )[0] ?? null;
// T3 Code's own idle compactions stay out of the shell unless they fail, so thread lists,
// notifications and the relay keep presenting the user's last turn.
const runs = projection.runs.filter((run) => !isSilentRunForShell(run, projection));
const latestRun =
  usageLimitRunPresentedAsLatest(
    runs,
    projection.turnItems,
    providerSession?.lastError ?? null,
  ) ?? latestUnheldRun(runs);
const activeRun =
  runs
    .filter(isInterruptibleRunForShell)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
const activityRun =
  runs.filter(isActivityRunForShell).toSorted((left, right) => right.ordinal - left.ordinal)[0] ??
  null;
const liveRunIds = new Set(runs.filter(isActivityRunForShell).map((run) => run.id));
let pendingRuntimeRequest = pendingRuntimeRequestSummary(
  projection.runtimeRequests
    .filter((request) => request.status === "pending")
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
    )[0] ?? null,
);
const userMessages = projection.messages
  .filter((message) => message.role === "user" && idleCompactionOf(message) === undefined)
  .toSorted(
    (left, right) =>
      DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
  );
const latestUserAuthoredMessageAt =
  userMessages.find((message) => message.createdBy === "user")?.updatedAt ?? null;
if (pendingRuntimeRequest === null || pendingRuntimeRequest.blocking === false) {
  pendingRuntimeRequest =
    secretRequestAsPendingInput(
      projection.turnItems
        .filter(
          (item) =>
            item.status === "waiting" &&
            waitsOnUser(item, liveRunIds, latestUserAuthoredMessageAt),
        )
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        )[0] ?? null,
    ) ?? pendingRuntimeRequest;
}
const latestUserMessage = userMessages[0] ?? null;
const pendingBackgroundTasks = derivePendingBackgroundWork({
  latestRun,
  providerThreads: projection.providerThreads,
  turnItems: projection.turnItems,
  activeProviderThreadId: projection.thread.activeProviderThreadId,
  runs,
  pullRequests: projection.thread.pullRequests,
});
return {
  createdBy: projection.thread.createdBy,
  creationSource: projection.thread.creationSource,
  id: projection.thread.id,
  projectId: projection.thread.projectId,
  title: projection.thread.title,
  providerInstanceId: projection.thread.providerInstanceId,
  modelSelection: projection.thread.modelSelection,
  runtimeMode: projection.thread.runtimeMode,
  interactionMode: projection.thread.interactionMode,
  branch: projection.thread.branch,
  worktreePath: projection.thread.worktreePath,
  pullRequests: threadPullRequestsOf(projection.thread),
  ...(projection.thread.linkedPullRequest === undefined
    ? {}
    : { linkedPullRequest: projection.thread.linkedPullRequest }),
  ...(projection.thread.branchPullRequest === undefined
    ? {}
    : { branchPullRequest: projection.thread.branchPullRequest }),
  ...(projection.thread.activeOrderKey === undefined
    ? {}
    : { activeOrderKey: projection.thread.activeOrderKey }),
  lineage: projection.thread.lineage,
  forkedFrom: projection.thread.forkedFrom,
  activeProviderThreadId: projection.thread.activeProviderThreadId,
  ...(projection.thread.historyOrigin === undefined
    ? {}
    : { historyOrigin: projection.thread.historyOrigin }),
  ...(projection.thread.linkOrigin === undefined
    ? {}
    : { linkOrigin: projection.thread.linkOrigin }),
  ...(projection.thread.delegatedFrom === undefined
    ? {}
    : { delegatedFrom: projection.thread.delegatedFrom }),
  latestRunId: latestRun?.id ?? null,
  latestRunRequestedAt: latestRun?.requestedAt ?? null,
  latestRunStartedAt: latestRun?.startedAt ?? null,
  latestRunCompletedAt: latestRun?.completedAt ?? null,
  latestRunStopRequested:
    latestRun != null &&
    projection.turnItems.some(
      (item) => item.runId === latestRun.id && item.type === "run_interrupt_request",
    ),
  activeRunId: activeRun?.id ?? null,
  blockedOnThreadWait: deriveBlockedOnThreadWait({ activeRun, turnItems: projection.turnItems }),
  activityRunStatus: activityRun?.status ?? null,
  activityRunStartedAt:
    activityRun === null ? null : orchestrationV2RunWorkStartedAt(activityRun),
  status: latestRun?.status ?? "idle",
  ...threadErrorSummary(
    latestRootProviderFailure(latestRun, projection.turnItems),
    providerSession?.lastError ?? null,
  ),
  pendingRuntimeRequest,
  pendingGuestMessageCount: pendingGuestMessageCount(projection.thread.guestShare),
  // Thread detail owns message bodies. Keeping them out of shell rows makes
  // initial hydration and streaming updates independent of transcript size.
  latestVisibleMessage: null,
  latestUserMessageAt: latestUserMessage?.updatedAt ?? null,
  latestUserAuthoredMessageAt,
  hasActionableProposedPlan: projection.plans.some(
    (plan) => plan.kind === "proposed_plan" && plan.status === "active",
  ),
  pendingBackgroundTasks: [...pendingBackgroundTasks],
  providerInstanceHistory: providerInstanceHistoryForShell({
    threadId: projection.thread.id,
    providerThreads: projection.providerThreads,
  }),
  goal: activeProviderGoalForShell(
    projection.providerThreads,
    projection.thread.activeProviderThreadId,
  ),
  itemCount: activeLocalTurnItems(projection).length,
  visibleItemCount: projection.visibleTurnItems.length,
  createdAt: projection.thread.createdAt,
  updatedAt: projection.thread.updatedAt,
  archivedAt: projection.thread.archivedAt,
  settledOverride: projection.thread.settledOverride,
  settledAt: projection.thread.settledAt,
  unsettledAt: projection.thread.unsettledAt ?? null,
  snoozedUntil: projection.thread.snoozedUntil ?? null,
  snoozedAt: projection.thread.snoozedAt ?? null,
  pinnedAt: projection.thread.pinnedAt ?? null,

  autoSettleDisabledAt: projection.thread.autoSettleDisabledAt ?? null,
  pinOrderKey: projection.thread.pinOrderKey ?? null,
  ...(projection.thread.tags?.length ? { tags: projection.thread.tags } : {}),
  lastVisitedAt: projection.thread.lastVisitedAt,
  opens: projection.thread.opens ?? null,
  titleRegeneration: projection.thread.titleRegeneration ?? null,
  limitRecovery: projection.thread.limitRecovery ?? null,
  deletedAt: projection.thread.deletedAt,
};
}

export type ShellThreadState = {
readonly thread: OrchestrationV2ThreadProjection["thread"];
readonly latestRunId: RunId | null;
readonly latestRunStatus: OrchestrationV2ShellThreadStatus;
readonly latestRunRequestedAt: DateTime.Utc | null;
readonly latestRunStartedAt: DateTime.Utc | null;
readonly latestRunCompletedAt: DateTime.Utc | null;
readonly latestRunStopRequested: boolean;
readonly activeRunId: RunId | null;
readonly blockedOnThreadWait: boolean;
readonly activityRunStatus: ShellActivityRunStatus | null;
readonly activityRunStartedAt: DateTime.Utc | null;
readonly lastError: string | null;
readonly lastErrorClass: OrchestrationV2ThreadShell["lastErrorClass"];
readonly lastErrorCode: OrchestrationV2ThreadShell["lastErrorCode"];
readonly usageLimitResetAt: OrchestrationV2ThreadShell["usageLimitResetAt"];
readonly pendingRuntimeRequest: OrchestrationV2PendingRuntimeRequestSummary | null;
readonly latestUserMessageAt: DateTime.Utc | null;
readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
readonly hasActionableProposedPlan: boolean;
readonly pendingBackgroundTasks: OrchestrationV2ThreadShell["pendingBackgroundTasks"];
readonly providerInstanceHistory: OrchestrationV2ThreadShell["providerInstanceHistory"];
readonly goal: OrchestrationV2ThreadShell["goal"];
readonly itemCount: number;
readonly runlessItemCount: number;
readonly updatedAt: OrchestrationV2ThreadProjection["updatedAt"];
readonly runOrdinalById: ReadonlyMap<RunId, number>;
readonly itemCountByRunId: ReadonlyMap<RunId, number>;
};

export function shellStatusFromStoredRunStatus(status: string | null): OrchestrationV2ShellThreadStatus {
switch (status) {
  case null:
    return "idle";
  case "preparing":
  case "queued":
  case "starting":
  case "running":
  case "waiting":
  case "completed":
  case "interrupted":
  case "failed":
  case "cancelled":
  case "rolled_back":
    return status;
  default:
    return "failed";
}
}

export function itemCountThroughRun(input: {
readonly state: ShellThreadState;
readonly runId: RunId;
}): number {
const runOrdinal = input.state.runOrdinalById.get(input.runId);
if (runOrdinal === undefined) {
  return 0;
}

let count = input.state.thread.historyOrigin === "v1_import" ? input.state.runlessItemCount : 0;
for (const [runId, itemCount] of input.state.itemCountByRunId) {
  const itemRunOrdinal = input.state.runOrdinalById.get(runId);
  if (itemRunOrdinal !== undefined && itemRunOrdinal <= runOrdinal) {
    count += itemCount;
  }
}
return count;
}

export function shellForkSourceIds(
rows: ReadonlyArray<{ readonly forked_from_run_source_thread_id: string | null }>,
): ReadonlyArray<ThreadId> {
return [
  ...new Set(
    rows.flatMap((row) =>
      row.forked_from_run_source_thread_id === null
        ? []
        : [ThreadId.make(row.forked_from_run_source_thread_id)],
    ),
  ),
];
}

export function visibleItemCountForShell(input: {
readonly threadId: ThreadId;
readonly statesByThreadId: ReadonlyMap<ThreadId, ShellThreadState>;
readonly seenThreadIds?: ReadonlySet<ThreadId>;
}): number {
const state = input.statesByThreadId.get(input.threadId);
if (state === undefined) {
  return 0;
}

const forkedFrom = inheritedRunFork(state.thread);
if (forkedFrom === null) {
  return state.itemCount;
}

const seenThreadIds = input.seenThreadIds ?? new Set<ThreadId>();
if (seenThreadIds.has(state.thread.id)) {
  return state.itemCount;
}

const sourceState = input.statesByThreadId.get(forkedFrom.threadId);
if (sourceState === undefined) {
  return state.itemCount;
}

const inheritedPrefixCount =
  inheritedRunFork(sourceState.thread) !== null
    ? visibleItemCountForShell({
        threadId: sourceState.thread.id,
        statesByThreadId: input.statesByThreadId,
        seenThreadIds: new Set([...seenThreadIds, state.thread.id]),
      }) - sourceState.itemCount
    : 0;

return (
  inheritedPrefixCount +
  itemCountThroughRun({ state: sourceState, runId: forkedFrom.runId }) +
  1 +
  state.itemCount
);
}

export function shellFromState(input: {
readonly state: ShellThreadState;
readonly visibleItemCount: number;
}): OrchestrationV2ThreadShell {
return {
  createdBy: input.state.thread.createdBy,
  creationSource: input.state.thread.creationSource,
  id: input.state.thread.id,
  projectId: input.state.thread.projectId,
  title: input.state.thread.title,
  providerInstanceId: input.state.thread.providerInstanceId,
  modelSelection: input.state.thread.modelSelection,
  runtimeMode: input.state.thread.runtimeMode,
  interactionMode: input.state.thread.interactionMode,
  branch: input.state.thread.branch,
  worktreePath: input.state.thread.worktreePath,
  pullRequests: threadPullRequestsOf(input.state.thread),
  ...(input.state.thread.linkedPullRequest === undefined
    ? {}
    : { linkedPullRequest: input.state.thread.linkedPullRequest }),
  ...(input.state.thread.branchPullRequest === undefined
    ? {}
    : { branchPullRequest: input.state.thread.branchPullRequest }),
  ...(input.state.thread.activeOrderKey === undefined
    ? {}
    : { activeOrderKey: input.state.thread.activeOrderKey }),
  lineage: input.state.thread.lineage,
  forkedFrom: input.state.thread.forkedFrom,
  activeProviderThreadId: input.state.thread.activeProviderThreadId,
  ...(input.state.thread.historyOrigin === undefined
    ? {}
    : { historyOrigin: input.state.thread.historyOrigin }),
  ...(input.state.thread.linkOrigin === undefined
    ? {}
    : { linkOrigin: input.state.thread.linkOrigin }),
  ...(input.state.thread.delegatedFrom === undefined
    ? {}
    : { delegatedFrom: input.state.thread.delegatedFrom }),
  latestRunId: input.state.latestRunId,
  latestRunRequestedAt: input.state.latestRunRequestedAt,
  latestRunStartedAt: input.state.latestRunStartedAt,
  latestRunCompletedAt: input.state.latestRunCompletedAt,
  latestRunStopRequested: input.state.latestRunStopRequested,
  activeRunId: input.state.activeRunId,
  blockedOnThreadWait: input.state.blockedOnThreadWait,
  activityRunStatus: input.state.activityRunStatus,
  activityRunStartedAt: input.state.activityRunStartedAt,
  status: input.state.latestRunStatus,
  lastError: input.state.lastError,
  lastErrorClass: input.state.lastErrorClass,
  lastErrorCode: input.state.lastErrorCode,
  usageLimitResetAt: input.state.usageLimitResetAt,
  pendingRuntimeRequest: input.state.pendingRuntimeRequest,
  pendingGuestMessageCount: pendingGuestMessageCount(input.state.thread.guestShare),
  latestVisibleMessage: null,
  latestUserMessageAt: input.state.latestUserMessageAt,
  latestUserAuthoredMessageAt: input.state.latestUserAuthoredMessageAt,
  hasActionableProposedPlan: input.state.hasActionableProposedPlan,
  pendingBackgroundTasks: input.state.pendingBackgroundTasks,
  providerInstanceHistory: input.state.providerInstanceHistory,
  goal: input.state.goal,
  itemCount: input.state.itemCount,
  visibleItemCount: input.visibleItemCount,
  createdAt: input.state.thread.createdAt,
  updatedAt: input.state.updatedAt,
  archivedAt: input.state.thread.archivedAt,
  settledOverride: input.state.thread.settledOverride,
  settledAt: input.state.thread.settledAt,
  unsettledAt: input.state.thread.unsettledAt ?? null,
  snoozedUntil: input.state.thread.snoozedUntil ?? null,
  snoozedAt: input.state.thread.snoozedAt ?? null,
  pinnedAt: input.state.thread.pinnedAt ?? null,

  autoSettleDisabledAt: input.state.thread.autoSettleDisabledAt ?? null,
  pinOrderKey: input.state.thread.pinOrderKey ?? null,
  ...(input.state.thread.tags?.length ? { tags: input.state.thread.tags } : {}),
  lastVisitedAt: input.state.thread.lastVisitedAt,
  opens: input.state.thread.opens ?? null,
  titleRegeneration: input.state.thread.titleRegeneration ?? null,
  limitRecovery: input.state.thread.limitRecovery ?? null,
  deletedAt: input.state.thread.deletedAt,
};
}
