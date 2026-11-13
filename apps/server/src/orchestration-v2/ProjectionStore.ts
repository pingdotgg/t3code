import { pendingGuestMessageCount } from "@t3tools/contracts";
import { applyThreadPullRequestLinkUpdate } from "../sourceControl/threadPullRequests.ts";
import { projectTurnItemForWire } from "./WireProjection.ts";
import * as Stream from "effect/Stream";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { makeThreadFind } from "./ThreadFind.ts";
import type {
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import {
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanArtifact,
  OrchestrationV2PendingRuntimeRequestSummary,
  PlanId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ContextTransfer,
  OrchestrationV2DomainEvent,
  OrchestrationV2OlderSettledCount,
  OrchestrationV2OlderSettledCursor,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  GuestShareId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
} from "@t3tools/contracts";
import {
  IDLE_COMPACTION_TEXT,
  idleCompactionOf,
  OrchestrationV2AppThreadJson as OrchestrationV2AppThreadJsonSchema,
  OrchestrationV2CheckpointJson as OrchestrationV2CheckpointJsonSchema,
  OrchestrationV2CheckpointScopeJson as OrchestrationV2CheckpointScopeJsonSchema,
  OrchestrationV2ContextHandoffJson as OrchestrationV2ContextHandoffJsonSchema,
  OrchestrationV2ContextTransferJson as OrchestrationV2ContextTransferJsonSchema,
  OrchestrationV2ConversationMessageJson as OrchestrationV2ConversationMessageJsonSchema,
  OrchestrationV2ExecutionNodeJson as OrchestrationV2ExecutionNodeJsonSchema,
  OrchestrationV2PlanArtifact as OrchestrationV2PlanArtifactSchema,
  OrchestrationV2ProviderSessionJson as OrchestrationV2ProviderSessionJsonSchema,
  OrchestrationV2ProviderThreadJson as OrchestrationV2ProviderThreadJsonSchema,
  OrchestrationV2ProviderTurnJson as OrchestrationV2ProviderTurnJsonSchema,
  OrchestrationV2RunAttemptJson as OrchestrationV2RunAttemptJsonSchema,
  OrchestrationV2RunJson as OrchestrationV2RunJsonSchema,
  OrchestrationV2RuntimeRequestJson as OrchestrationV2RuntimeRequestJsonSchema,
  OrchestrationV2SubagentJson as OrchestrationV2SubagentJsonSchema,
  OrchestrationV2TurnItemJson as OrchestrationV2TurnItemJsonSchema,
  orchestrationV2RunWorkStartedAt,
  RunId,
  MessageId,
  RuntimeRequestId,
  CheckpointScopeId,
  CheckpointId,
  ThreadId,
  TurnItemId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  createOrchestrationV2TurnItemVisibility,
  isOrchestrationV2SupersededInterrupt,
} from "@t3tools/shared/orchestrationV2Timeline";
import {
  deriveBlockedOnThreadWait,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { MCP_APP_OUTPUT_KEY } from "@t3tools/shared/mcpApp";
import { threadHtmlRenderAttachmentIds } from "../attachmentStore.ts";
import {
  isThreadHistoryUserTurn,
  isConversationHistoryItem,
  THREAD_HISTORY_MAX_RAW_TURNS,
  missingInterruptRequests,
  deferWorkHistoryRows,
  selectDeferredWorkPage,
  encodeThreadHistoryCursor,
  olderHistoryPagePolicy,
  selectHistoryPageFromCursor,
  selectRecentTimelineWindow,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_INLINE_WORK_ITEM_LIMIT,
  THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";

// ---- decomposition ----
export * from "./ProjectionStorePrelude/BuildVisibleTurnItems.ts";
export * from "./ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
export * from "./ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
export * from "./ProjectionStorePrelude/ThreadShellFromProjection.ts";

import { type ProjectionStoreV2Shape } from "./ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import { installApplyRecordTail } from "./ProjectionStoreParts/ApplyRecordTail.ts";
import { installApplyRunTail } from "./ProjectionStoreParts/ApplyRunTail.ts";
import { installRetainedWindowRows } from "./ProjectionStoreParts/RetainedWindowRows.ts";
import { installReadCanonicalProjection } from "./ProjectionStoreParts/ReadCanonicalProjection.ts";
import { installReadProjection } from "./ProjectionStoreParts/ReadProjection.ts";
import { installGetUnreadableThreadIds } from "./ProjectionStoreParts/GetUnreadableThreadIds.ts";
import { installGetRuntimeRecoveryProjection } from "./ProjectionStoreParts/GetRuntimeRecoveryProjection.ts";
import { installGetCheckpointRollbackContext } from "./ProjectionStoreParts/GetCheckpointRollbackContext.ts";
import { installReadTimelineIndex } from "./ProjectionStoreParts/ReadTimelineIndex.ts";
import { installSelectShellThreadRows } from "./ProjectionStoreParts/SelectShellThreadRows.ts";
import { installShellThreadStateFromRow } from "./ProjectionStoreParts/ShellThreadStateFromRow.ts";
import { installGetThreadShell } from "./ProjectionStoreParts/GetThreadShell.ts";

export class ProjectionStoreV2 extends Context.Service<ProjectionStoreV2, ProjectionStoreV2Shape>()(
  "t3/orchestration-v2/ProjectionStore/ProjectionStoreV2",
) {}

export const layer: Layer.Layer<ProjectionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
  const ApplyRecordTail = yield* installApplyRecordTail({});
  const ApplyRunTail = yield* installApplyRunTail({ ...ApplyRecordTail });
  const RetainedWindowRows = yield* installRetainedWindowRows({ ...ApplyRecordTail, ...ApplyRunTail });
  const ReadCanonicalProjection = yield* installReadCanonicalProjection({ ...ApplyRecordTail, ...ApplyRunTail, ...RetainedWindowRows });
  const ReadProjection = yield* installReadProjection({ ...ApplyRecordTail, ...ApplyRunTail, ...RetainedWindowRows, ...ReadCanonicalProjection });
  const GetUnreadableThreadIds = yield* installGetUnreadableThreadIds({ ...ApplyRecordTail, ...ApplyRunTail, ...RetainedWindowRows, ...ReadCanonicalProjection, ...ReadProjection });
  const GetRuntimeRecoveryProjection = yield* installGetRuntimeRecoveryProjection({ ...ApplyRecordTail, ...ApplyRunTail, ...RetainedWindowRows, ...ReadCanonicalProjection, ...ReadProjection, ...GetUnreadableThreadIds });
  const GetCheckpointRollbackContext = yield* installGetCheckpointRollbackContext({ ...ApplyRecordTail, ...ApplyRunTail, ...RetainedWindowRows, ...ReadCanonicalProjection, ...ReadProjection, ...GetUnreadableThreadIds, ...GetRuntimeRecoveryProjection });
  const ReadTimelineIndex = yield* installReadTimelineIndex({ ...ApplyRecordTail, ...ApplyRunTail, ...RetainedWindowRows, ...ReadCanonicalProjection, ...ReadProjection, ...GetUnreadableThreadIds, ...GetRuntimeRecoveryProjection, ...GetCheckpointRollbackContext });
  const SelectShellThreadRows = yield* installSelectShellThreadRows({ ...ApplyRecordTail, ...ApplyRunTail, ...RetainedWindowRows, ...ReadCanonicalProjection, ...ReadProjection, ...GetUnreadableThreadIds, ...GetRuntimeRecoveryProjection, ...GetCheckpointRollbackContext, ...ReadTimelineIndex });
  const ShellThreadStateFromRow = yield* installShellThreadStateFromRow({ ...ApplyRecordTail, ...ApplyRunTail, ...RetainedWindowRows, ...ReadCanonicalProjection, ...ReadProjection, ...GetUnreadableThreadIds, ...GetRuntimeRecoveryProjection, ...GetCheckpointRollbackContext, ...ReadTimelineIndex, ...SelectShellThreadRows });
  const GetThreadShell = yield* installGetThreadShell({ ...ApplyRecordTail, ...ApplyRunTail, ...RetainedWindowRows, ...ReadCanonicalProjection, ...ReadProjection, ...GetUnreadableThreadIds, ...GetRuntimeRecoveryProjection, ...GetCheckpointRollbackContext, ...ReadTimelineIndex, ...SelectShellThreadRows, ...ShellThreadStateFromRow });
  const { apply, canStartQueuedRun, countThreads, findGuestShareThreadId, getCheckpointCaptureContext, getCheckpointContext, getCheckpointRollbackContext, getHeldQueuedRuns, getLimitRecoveryCandidates, getLimitRecoveryWakeAt, getMessageCount, getNextTurnItemOrdinal, getOpenRemoteDelegatedTasks, getPendingNativeUserInputs, getPlan, getProviderControlContext, getPullRequestSnapshot, getRecoveryThreadIds, getRunMessage, getRunningTurnContext, getRuntimeRecoveryProjection, getRuntimeRequest, getRuntimeResponseContext, getSettlementCandidates, getShellSnapshot, getSubagentCount, getThread, getThreadAttachmentIds, getThreadHistoryPage, getThreadProjection, getThreadProviderContext, getThreadRecords, getThreadShell, getThreadSnapshot, getThreadSnapshotWindow, getThreadWorktreePaths, getThreadsWithPullRequests, getTimelinePage, getTurnItem, getTurnStartContext, getTurnStartHistory, getUnreadableThreadIds, hasUnpairedRunInterruptRequest, isNodeStored, listActiveShellIndex, listActiveSubagentThreadIds, listAppOwnedChildThreadIds, listOlderSettledThreads, readOnReader, readShellSnapshot, searchThread, searchThreadStream } = { ...ApplyRecordTail, ...ApplyRunTail, ...RetainedWindowRows, ...ReadCanonicalProjection, ...ReadProjection, ...GetUnreadableThreadIds, ...GetRuntimeRecoveryProjection, ...GetCheckpointRollbackContext, ...ReadTimelineIndex, ...SelectShellThreadRows, ...ShellThreadStateFromRow, ...GetThreadShell };
return {
    apply,
    getShellSnapshot: readOnReader(getShellSnapshot),
    getPullRequestSnapshot: readOnReader(getPullRequestSnapshot),
    listActiveSubagentThreadIds: readOnReader(listActiveSubagentThreadIds),
    countThreads: readOnReader(countThreads),
    listActiveShellIndex: readOnReader(listActiveShellIndex),
    readShellSnapshot: readOnReader(readShellSnapshot),
    listOlderSettledThreads: readOnReader(listOlderSettledThreads),
    getThreadShell: readOnReader(getThreadShell),
    findGuestShareThreadId: readOnReader(findGuestShareThreadId),
    getThread: readOnReader(getThread),
    getSettlementCandidates: readOnReader(getSettlementCandidates),
    getThreadsWithPullRequests: readOnReader(getThreadsWithPullRequests),
    getThreadWorktreePaths: readOnReader(getThreadWorktreePaths),
    getOpenRemoteDelegatedTasks: getOpenRemoteDelegatedTasks.pipe(NodeSqliteClient.readOnly),
    getThreadProjection: readOnReader(getThreadProjection),
    getTurnStartContext: readOnReader(getTurnStartContext),
    getTurnStartHistory: readOnReader(getTurnStartHistory),
    getRuntimeRecoveryProjection: readOnReader(getRuntimeRecoveryProjection),
    getRunningTurnContext: readOnReader(getRunningTurnContext),
    getThreadProviderContext: readOnReader(getThreadProviderContext),
    getRuntimeResponseContext: readOnReader(getRuntimeResponseContext),
    getCheckpointContext: readOnReader(getCheckpointContext),
    getCheckpointCaptureContext: readOnReader(getCheckpointCaptureContext),
    getCheckpointRollbackContext: readOnReader(getCheckpointRollbackContext),
    getRunMessage: readOnReader(getRunMessage),
    canStartQueuedRun: readOnReader(canStartQueuedRun),
    getHeldQueuedRuns: readOnReader(getHeldQueuedRuns),
    getPendingNativeUserInputs: readOnReader(getPendingNativeUserInputs),
    hasUnpairedRunInterruptRequest: readOnReader(hasUnpairedRunInterruptRequest),
    isNodeStored: readOnReader(isNodeStored),
    getMessageCount: readOnReader(getMessageCount),
    getSubagentCount: readOnReader(getSubagentCount),
    listAppOwnedChildThreadIds: readOnReader(listAppOwnedChildThreadIds),
    getNextTurnItemOrdinal: readOnReader(getNextTurnItemOrdinal),
    getTurnItem: readOnReader(getTurnItem),
    getThreadRecords: (threadId, fields, filter) =>
      getThreadRecords(threadId, fields, filter).pipe(NodeSqliteClient.readOnly),
    getRuntimeRequest: readOnReader(getRuntimeRequest),
    getPlan: readOnReader(getPlan),
    getProviderControlContext: readOnReader(getProviderControlContext),
    getLimitRecoveryCandidates: readOnReader(getLimitRecoveryCandidates),
    getLimitRecoveryWakeAt: readOnReader(getLimitRecoveryWakeAt),
    getRecoveryThreadIds: readOnReader(getRecoveryThreadIds),
    getUnreadableThreadIds: readOnReader(getUnreadableThreadIds),
    getThreadSnapshot: readOnReader(getThreadSnapshot),
    getThreadSnapshotWindow: readOnReader(getThreadSnapshotWindow),
    getTimelinePage: readOnReader(getTimelinePage),
    getThreadHistoryPage: readOnReader(getThreadHistoryPage),
    searchThread: readOnReader(searchThread),
    searchThreadStream,
    getThreadAttachmentIds: readOnReader(getThreadAttachmentIds),
  } satisfies ProjectionStoreV2Shape;
}),
);
