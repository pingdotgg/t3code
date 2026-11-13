import { pendingGuestMessageCount } from "@t3tools/contracts";
import type { OrchestrationV2AppThread, OrchestrationV2Checkpoint, OrchestrationV2CheckpointScope, OrchestrationV2ExecutionNode, OrchestrationV2ConversationMessage, OrchestrationV2ContextTransfer, OrchestrationV2OlderSettledCount, OrchestrationV2OlderSettledCursor, OrchestrationV2ProjectedTurnItem, OrchestrationV2ProviderThread, OrchestrationV2ProviderTurn, OrchestrationV2Run, OrchestrationV2RuntimeRequest, OrchestrationV2ThreadShell, OrchestrationV2ThreadProjection, OrchestrationV2TurnItem, ProviderThreadId, ProviderTurnId, RunAttemptId } from "@t3tools/contracts";
import { OrchestrationV2AppThreadJson as OrchestrationV2AppThreadJsonSchema, OrchestrationV2CheckpointJson as OrchestrationV2CheckpointJsonSchema, OrchestrationV2CheckpointScopeJson as OrchestrationV2CheckpointScopeJsonSchema, OrchestrationV2RunAttemptJson as OrchestrationV2RunAttemptJsonSchema, OrchestrationV2RunJson as OrchestrationV2RunJsonSchema, RunId, MessageId, ThreadId, TurnItemId, NodeId, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
export class ProjectionStoreApplyEventError extends Schema.TaggedError<ProjectionStoreApplyEventError>()(
"ProjectionStoreApplyEventError",
{
  eventType: Schema.String,
  cause: Schema.optional(Schema.Defect()),
},
) {
override get message(): string {
  return `Failed to apply orchestration projection event ${this.eventType}.`;
}
}

export class ProjectionStoreSetupError extends Schema.TaggedError<ProjectionStoreSetupError>()(
"ProjectionStoreSetupError",
{
  cause: Schema.optional(Schema.Defect()),
},
) {
override get message(): string {
  return "Failed to initialize orchestration projection store.";
}
}

export class ProjectionStoreThreadNotFoundError extends Schema.TaggedError<ProjectionStoreThreadNotFoundError>()(
"ProjectionStoreThreadNotFoundError",
{
  threadId: ThreadId,
},
) {
override get message(): string {
  return `No orchestration projection exists for thread ${this.threadId}.`;
}
}

export class ProjectionStoreReadError extends Schema.TaggedError<ProjectionStoreReadError>()(
"ProjectionStoreReadError",
{
  threadId: ThreadId,
  cause: Schema.optional(Schema.Defect()),
},
) {
override get message(): string {
  return `Failed to read orchestration projection for thread ${this.threadId}.`;
}
}

export const ProjectionStoreV2Error = Schema.Union([
ProjectionStoreSetupError,
ProjectionStoreApplyEventError,
ProjectionStoreThreadNotFoundError,
ProjectionStoreReadError,
]);

export type ProjectionStoreV2Error = typeof ProjectionStoreV2Error.Type;

export type ProjectionRecoveryKind =
| "queued-runs"
| "runtime"
| "subagent-results"
| "delegated-completions";

export type ProjectionLimitRecoveryCandidate = Pick<
OrchestrationV2ThreadShell,
| "id"
| "status"
| "lastErrorClass"
| "latestRunId"
| "usageLimitResetAt"
| "archivedAt"
| "settledOverride"
| "pendingRuntimeRequest"
| "latestRunCompletedAt"
| "updatedAt"
| "limitRecovery"
| "snoozedUntil"
>;

export type ProjectionThreadPullRequests = Pick<
OrchestrationV2AppThread,
"id" | "projectId" | "lineage" | "settledOverride" | "settledAt" | "pullRequests"
>;

export type ProjectionSettlementCandidate = Pick<
OrchestrationV2ThreadShell,
| "id"
| "projectId"
| "branch"
| "worktreePath"
| "pullRequests"
| "linkedPullRequest"
| "branchPullRequest"
| "createdAt"
| "updatedAt"
| "archivedAt"
| "settledOverride"
| "pinnedAt"
| "autoSettleDisabledAt"
| "snoozedUntil"
| "snoozedAt"
| "latestRunId"
| "latestRunRequestedAt"
| "latestRunStartedAt"
| "latestRunCompletedAt"
| "latestUserMessageAt"
| "status"
| "activityRunStartedAt"
| "activityRunStatus"
| "pendingRuntimeRequest"
| "pendingBackgroundTasks"
| "pendingGuestMessageCount"
> &
Pick<OrchestrationV2AppThread, "lastSnoozeWakeAt"> & {
  readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
};

export const ProjectionCheckpointContext = Schema.Struct({
runs: Schema.Array(
  OrchestrationV2RunJsonSchema.mapFields(({ id, ordinal, status }) => ({ id, ordinal, status })),
),
checkpointScopes: Schema.Array(
  OrchestrationV2CheckpointScopeJsonSchema.mapFields(({ id, runId, kind, cwd }) => ({
    id,
    runId,
    kind,
    cwd,
  })),
),
checkpoints: Schema.Array(
  OrchestrationV2CheckpointJsonSchema.mapFields(
    ({ scopeId, runId, ordinalWithinScope, appRunOrdinal, status, ref }) => ({
      scopeId,
      runId,
      ordinalWithinScope,
      appRunOrdinal,
      status,
      ref,
    }),
  ),
),
});

export type ProjectionCheckpointContext = typeof ProjectionCheckpointContext.Type;

export const decodeCheckpointContext = Schema.decodeUnknownEffect(ProjectionCheckpointContext);

export interface ProjectionCheckpointCaptureContext {
readonly run: OrchestrationV2Run | undefined;
readonly rootNode: OrchestrationV2ExecutionNode | undefined;
readonly scope: OrchestrationV2CheckpointScope | undefined;
readonly providerThread: OrchestrationV2ProviderThread | undefined;
readonly readyCheckpointOrdinals: ReadonlyArray<number>;
/** Side chats share their parent's worktree and never snapshot it. */
readonly sideChat: boolean;
}

export const RollbackTargetAttempts = Schema.Array(
OrchestrationV2RunAttemptJsonSchema.mapFields(({ id, providerTurnId }) => ({
  id,
  providerTurnId,
})),
);

export const decodeRollbackTargetAttempts = Schema.decodeUnknownEffect(RollbackTargetAttempts);

export interface ProjectionCheckpointRollbackContext {
readonly thread: OrchestrationV2AppThread;
readonly providerThread: OrchestrationV2ProviderThread | undefined;
readonly providerSession: OrchestrationV2ThreadProjection["providerSessions"][number] | undefined;
readonly checkpoint: OrchestrationV2Checkpoint | undefined;
readonly scope: OrchestrationV2CheckpointScope | undefined;
readonly targetAttempt: (typeof RollbackTargetAttempts.Type)[number] | undefined;
readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
readonly rolledBackAttemptIds: ReadonlyArray<RunAttemptId>;
readonly runsToRollback: ReadonlyArray<OrchestrationV2Run>;
readonly rootNodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
readonly staleCheckpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
}

export interface ProjectionProviderControlContext {
readonly providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] | undefined;
readonly providerTurn: OrchestrationV2ProviderTurn | undefined;
readonly attempt: OrchestrationV2ThreadProjection["attempts"][number] | undefined;
readonly message: OrchestrationV2ConversationMessage | undefined;
readonly run: OrchestrationV2Run | undefined;
}

export interface ProjectionProviderControlTarget {
readonly providerThreadId: ProviderThreadId;
readonly providerTurnId: ProviderTurnId;
readonly attemptId?: RunAttemptId;
readonly messageId?: MessageId;
}

export type ProjectionRuntimeRecoveryState = Pick<
OrchestrationV2ThreadProjection,
| "thread"
| "runs"
| "attempts"
| "nodes"
| "subagents"
| "providerSessions"
| "providerThreads"
| "providerTurns"
| "runtimeRequests"
| "messages"
| "turnItems"
>;

export type ProjectionPendingUserInputs = Pick<
OrchestrationV2ThreadProjection,
"runtimeRequests" | "nodes" | "turnItems"
>;

export type ProjectionThreadProviderContext = Pick<
OrchestrationV2ThreadProjection,
"thread" | "providerSessions" | "providerThreads"
>;

export interface ProjectionRuntimeResponseContext {
readonly request: OrchestrationV2ThreadProjection["runtimeRequests"][number] | undefined;
readonly node: OrchestrationV2ThreadProjection["nodes"][number] | undefined;
readonly item: OrchestrationV2ThreadProjection["turnItems"][number] | undefined;
readonly session: OrchestrationV2ThreadProjection["providerSessions"][number] | undefined;
}

export interface ProjectionRecordFilter {
readonly providerThreadIds?: ReadonlyArray<ProviderThreadId>;
readonly providerTurnAttemptIds?: ReadonlyArray<RunAttemptId>;
readonly messageRoles?: ReadonlyArray<OrchestrationV2ConversationMessage["role"]>;
readonly monitorNotificationsOnly?: boolean;
readonly turnItemRunId?: RunId;
readonly messageIds?: ReadonlyArray<MessageId>;
readonly messageRunIds?: ReadonlyArray<RunId>;
readonly turnItemRunIds?: ReadonlyArray<RunId | null>;
readonly turnItemNodeIds?: ReadonlyArray<NodeId>;
readonly runIds?: ReadonlyArray<RunId>;
readonly runStatuses?: ReadonlyArray<OrchestrationV2Run["status"]>;
/** Keeps the thread's highest-ordinal run even when `runStatuses` excludes it. */
readonly includeLatestRun?: true;
readonly providerTurnThreadIds?: ReadonlyArray<ProviderThreadId>;
/** Only the provider turn whose token usage was updated last. */
readonly latestProviderTurnUsageOnly?: true;
readonly runtimeRequestStatuses?: ReadonlyArray<OrchestrationV2RuntimeRequest["status"]>;
readonly contextTransferStatuses?: ReadonlyArray<OrchestrationV2ContextTransfer["status"]>;
readonly subagentIds?: ReadonlyArray<NodeId>;
readonly subagentRunIds?: ReadonlyArray<RunId>;
readonly nodeIds?: ReadonlyArray<NodeId>;
readonly turnItemTypes?: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
readonly turnItemStatuses?: ReadonlyArray<OrchestrationV2TurnItem["status"]>;
readonly omitSettledLeafNodes?: boolean;
/**
 * Skips ended subagents whose completion was acknowledged, delivered or disposed, unless their
 * run is active or `except` names them.
 */
readonly omitSettledSubagents?: true | { readonly except: ReadonlyArray<NodeId> };
}

export const inheritsForkConversation = ({
thread,
contextTransfers,
contextHandoffs,
}: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers" | "contextHandoffs">) => {
if (thread.forkedFrom?.type !== "run") return false;
const resolution = contextTransfers.find(
  (transfer) => transfer.type === "fork" && transfer.targetThreadId === thread.id,
)?.resolution;
return (
  resolution?.strategy !== "portable_context" ||
  contextHandoffs.some(
    (handoff) =>
      handoff.id === resolution.contextHandoffId && (handoff.history?.messages.length ?? 0) > 0,
  )
);
};

export type ProjectionRecordField = Exclude<
keyof OrchestrationV2ThreadProjection,
"thread" | "updatedAt" | "visibleTurnItems"
>;

export type ProjectionRecords<K extends ProjectionRecordField> = Pick<
OrchestrationV2ThreadProjection,
"thread" | K
>;

export interface ProjectionTimelinePageOptions {
readonly afterPosition?: number;
readonly itemId?: TurnItemId;
readonly attachmentId?: string;
readonly view?: "messages" | "activity";
readonly limit: number;
}

export interface ProjectionTimelinePage {
readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
readonly totalItems: number;
readonly hasMore: boolean;
}

export interface ShellSnapshotOptions {
readonly location?: "active" | "archive";
readonly projectId?: ProjectId;
readonly unsettledOnly?: boolean;
/**
 * Only the threads sharing this thread's `lineage.rootThreadId`: the root, its forks, and their
 * subagent trees. The thread may be deleted: forks keep a deleted source's root.
 */
readonly familyOf?: ThreadId;
readonly worktreePath?: string;
readonly threadIds?: ReadonlyArray<ThreadId>;
}

export interface ActiveShellIndexEntry extends Pick<
OrchestrationV2ThreadShell,
"id" | "projectId" | "lineage" | "settledOverride" | "settledAt" | "pinnedAt" | "snoozedUntil"
> {
/** False only when no run, request, work item, or watch can make the shell live. */
readonly mayBeLive: boolean;
}

export interface OlderSettledThreadsQuery {
readonly before: OrchestrationV2OlderSettledCursor;
readonly projectIds?: ReadonlyArray<ProjectId> | undefined;
readonly limit: number;
}

export interface OlderSettledThreadsListing {
readonly threadIds: ReadonlyArray<ThreadId>;
/** Only for `limit: 0`. */
readonly counts: ReadonlyArray<OrchestrationV2OlderSettledCount>;
}

export const PullRequestThread = OrchestrationV2AppThreadJsonSchema.mapFields(
({
  id,
  projectId,
  lineage,
  branch,
  worktreePath,
  archivedAt,
  settledOverride,
  settledAt,
  linkedPullRequest,
  branchPullRequest,
  pullRequests,
}) => ({
  id,
  projectId,
  lineage,
  branch,
  worktreePath,
  archivedAt,
  settledOverride,
  settledAt,
  linkedPullRequest,
  branchPullRequest,
  pullRequests,
}),
);
