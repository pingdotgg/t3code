// Domain events, thread projections, shells and stream items.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NodeId,
  ForwardCompatibleUnion,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderThreadId,
  RawEventId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { StoredThreadTags } from "./threadTags.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "./threadPullRequest.ts";
import {
  ProviderInteractionMode,
  RuntimeMode,
} from "./providerPolicy.ts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
} from "./providerInstance.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";

import {
  LenientThreadOpens,
  OrchestrationV2AppThread,
  OrchestrationV2AppThreadLineage,
  OrchestrationV2ContextTransfer,
  OrchestrationV2CreationFields,
  OrchestrationV2DelegatedFrom,
  OrchestrationV2LimitRecovery,
  OrchestrationV2LinkOrigin,
  OrchestrationV2ThreadHistoryOrigin,
  isListedThreadLineage,
} from "./orchestrationV2Base.ts";

import {
  OrchestrationV2CheckpointScope,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderGoal,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderSessionDetached,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2RunBackgroundWorkCancelled,
  OrchestrationV2RunStatus,
  OrchestrationV2Subagent,
} from "./orchestrationV2Runs.ts";

import {
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointRollbackRequest,
  OrchestrationV2ContextHandoff,
  OrchestrationV2ConversationMessage,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
} from "./orchestrationV2Turns.ts";

import {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  projectedTurnItemArray,
  turnItemArray,
} from "./orchestrationV2TurnItems.ts";

export const OrchestrationV2EventBase = Schema.Struct({
  id: EventId,
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  nodeId: Schema.optional(NodeId),
  driver: Schema.optional(ProviderDriverKind),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  rawEventId: Schema.optional(RawEventId),
  occurredAt: Schema.DateTimeUtc,
});

export const OrchestrationV2DomainEvent = Schema.Union([
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("thread.created"),
    payload: OrchestrationV2AppThread,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literals([
      "thread.archived",
      "thread.unarchived",
      "thread.deleted",
      "thread.settled",
      "thread.unsettled",
      "thread.snoozed",
      "thread.unsnoozed",
      "thread.pinned",
      "thread.auto-settle-set",
      "thread.unpinned",
      "thread.pin-reordered",
      "thread.active-reordered",
      "thread.tags-updated",
      "thread.visited",
      "thread.marked-unread",
      "thread.metadata-updated",
      "thread.pull-request-synced",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.guest-share-updated",
    ]),
    payload: OrchestrationV2AppThread,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("thread.pull-request-link-updated"),
    payload: ThreadPullRequestLink,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("run.created"),
    payload: OrchestrationV2Run,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("run.updated"),
    payload: OrchestrationV2Run,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("run.background-work-cancelled"),
    payload: OrchestrationV2RunBackgroundWorkCancelled,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("run-attempt.created"),
    payload: OrchestrationV2RunAttempt,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("run-attempt.updated"),
    payload: OrchestrationV2RunAttempt,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("node.updated"),
    payload: OrchestrationV2ExecutionNode,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("subagent.updated"),
    payload: OrchestrationV2Subagent,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literals(["provider-session.attached", "provider-session.updated"]),
    payload: OrchestrationV2ProviderSession,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("provider-session.detached"),
    payload: OrchestrationV2ProviderSessionDetached,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("provider-thread.updated"),
    payload: OrchestrationV2ProviderThread,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("provider-turn.updated"),
    payload: OrchestrationV2ProviderTurn,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("runtime-request.updated"),
    payload: OrchestrationV2RuntimeRequest,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("message.updated"),
    payload: OrchestrationV2ConversationMessage,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("turn-item.updated"),
    payload: OrchestrationV2TurnItem,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("plan.updated"),
    payload: OrchestrationV2PlanArtifact,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("checkpoint-scope.created"),
    payload: OrchestrationV2CheckpointScope,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("checkpoint.captured"),
    payload: OrchestrationV2Checkpoint,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("checkpoint.rollback-requested"),
    payload: OrchestrationV2CheckpointRollbackRequest,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("context-handoff.updated"),
    payload: OrchestrationV2ContextHandoff,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("context-transfer.created"),
    payload: OrchestrationV2ContextTransfer,
  }),
  Schema.Struct({
    ...OrchestrationV2EventBase.fields,
    type: Schema.Literal("context-transfer.updated"),
    payload: OrchestrationV2ContextTransfer,
  }),
]);

export type OrchestrationV2DomainEvent = typeof OrchestrationV2DomainEvent.Type;

export const OrchestrationV2ThreadProjection = Schema.Struct({
  thread: OrchestrationV2AppThread,
  runs: Schema.Array(OrchestrationV2Run),
  attempts: Schema.Array(OrchestrationV2RunAttempt),
  nodes: Schema.Array(OrchestrationV2ExecutionNode),
  subagents: Schema.Array(OrchestrationV2Subagent),
  providerSessions: Schema.Array(OrchestrationV2ProviderSession),
  providerThreads: Schema.Array(OrchestrationV2ProviderThread),
  providerTurns: Schema.Array(OrchestrationV2ProviderTurn),
  runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
  messages: Schema.Array(OrchestrationV2ConversationMessage),
  plans: Schema.Array(OrchestrationV2PlanArtifact),
  turnItems: turnItemArray(OrchestrationV2TurnItem),
  checkpointScopes: Schema.Array(OrchestrationV2CheckpointScope),
  checkpoints: Schema.Array(OrchestrationV2Checkpoint),
  contextHandoffs: Schema.Array(OrchestrationV2ContextHandoff),
  contextTransfers: Schema.Array(OrchestrationV2ContextTransfer),
  visibleTurnItems: projectedTurnItemArray(
    OrchestrationV2ProjectedTurnItem,
    OrchestrationV2ProjectedTurnItem.mapFields((fields) => ({
      ...fields,
      item: ForwardCompatibleUnion(OrchestrationV2TurnItem.members, "type"),
    })),
  ),
  updatedAt: Schema.DateTimeUtc,
});

export type OrchestrationV2ThreadProjection = typeof OrchestrationV2ThreadProjection.Type;

export const OrchestrationV2ThreadTranscript = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  updatedAt: Schema.DateTimeUtc,
  items: Schema.Array(OrchestrationV2ProjectedTurnItem),
});

export type OrchestrationV2ThreadTranscript = typeof OrchestrationV2ThreadTranscript.Type;

export const OrchestrationV2ShellThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  OrchestrationV2RunStatus,
]);

export type OrchestrationV2ShellThreadStatus = typeof OrchestrationV2ShellThreadStatus.Type;

export const OrchestrationV2PendingRuntimeRequestSummary = Schema.Struct({
  id: RuntimeRequestId,
  kind: OrchestrationV2RuntimeRequest.fields.kind,
  createdAt: Schema.DateTimeUtc,
  /** False for async questions the run keeps working past. Absent from older servers. */
  blocking: Schema.optional(Schema.Boolean),
});

export type OrchestrationV2PendingRuntimeRequestSummary =
  typeof OrchestrationV2PendingRuntimeRequestSummary.Type;

export const OrchestrationV2LatestVisibleMessageSummary = Schema.Struct({
  id: MessageId,
  role: OrchestrationV2ConversationMessage.fields.role,
  text: Schema.String,
  updatedAt: Schema.DateTimeUtc,
});

export type OrchestrationV2LatestVisibleMessageSummary =
  typeof OrchestrationV2LatestVisibleMessageSummary.Type;

export const OrchestrationV2ThreadShell = Schema.Struct({
  ...OrchestrationV2CreationFields,
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  providerInstanceId: ProviderInstanceId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  pullRequests: Schema.optional(Schema.Array(ThreadPullRequestLink)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  lineage: OrchestrationV2AppThreadLineage,
  forkedFrom: Schema.NullOr(OrchestrationV2AppThread.fields.forkedFrom),
  activeProviderThreadId: Schema.NullOr(ProviderThreadId),
  historyOrigin: Schema.optional(OrchestrationV2ThreadHistoryOrigin),
  linkOrigin: Schema.optional(OrchestrationV2LinkOrigin),
  delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
  latestRunId: Schema.NullOr(RunId),
  latestRunRequestedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  latestRunStartedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  latestRunCompletedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  latestRunStopRequested: Schema.optional(Schema.Boolean),
  activeRunId: Schema.NullOr(RunId),
  activityRunStartedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  activityRunStatus: Schema.optional(
    Schema.NullOr(Schema.Literals(["preparing", "starting", "running", "waiting"])),
  ),
  blockedOnThreadWait: Schema.optional(Schema.Boolean),
  status: OrchestrationV2ShellThreadStatus,
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
  lastErrorClass: Schema.optional(Schema.NullOr(OrchestrationV2ProviderFailureClass)),
  lastErrorCode: Schema.optional(Schema.NullOr(Schema.String)),
  usageLimitResetAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pendingRuntimeRequest: Schema.NullOr(OrchestrationV2PendingRuntimeRequestSummary),
  /** Guest messages waiting for the owner to send or dismiss. Absent from older servers. */
  pendingGuestMessageCount: Schema.optional(NonNegativeInt),
  latestVisibleMessage: Schema.NullOr(OrchestrationV2LatestVisibleMessageSummary),
  latestUserMessageAt: Schema.NullOr(Schema.DateTimeUtc),
  /** Excludes wakes and agent messages that advance latestUserMessageAt through the user role. */
  latestUserAuthoredMessageAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  hasActionableProposedPlan: Schema.Boolean,
  pendingBackgroundTasks: Schema.optional(Schema.Array(OrchestrationV2PendingBackgroundTask)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  providerInstanceHistory: Schema.optional(Schema.Array(ProviderInstanceId)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  goal: Schema.optional(Schema.NullOr(OrchestrationV2ProviderGoal)),
  itemCount: NonNegativeInt,
  visibleItemCount: NonNegativeInt,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  archivedAt: Schema.NullOr(Schema.DateTimeUtc),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(Schema.DateTimeUtc),
  unsettledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  snoozedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  limitRecovery: Schema.optional(Schema.NullOr(OrchestrationV2LimitRecovery)),
  pinnedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** Absent on threads written before tags existed; read as empty. */
  tags: Schema.optional(StoredThreadTags),
  lastVisitedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  opens: Schema.optional(LenientThreadOpens),
  titleRegeneration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requestId: CommandId,
        startedAt: Schema.DateTimeUtc,
      }),
    ),
  ),
  deletedAt: Schema.NullOr(Schema.DateTimeUtc),
});

export type OrchestrationV2ThreadShell = typeof OrchestrationV2ThreadShell.Type;

const LIVE_SHELL_STATUSES: ReadonlySet<OrchestrationV2ShellThreadStatus> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/**
 * A subagent child that can still need the user or hold its parent. Shells that omit idle children
 * keep these, so every reader of live child rows (pending requests, working parents, background
 * work) still finds them.
 */
export function isLiveSubagentShell(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "activityRunStatus" | "status" | "pendingRuntimeRequest" | "pendingBackgroundTasks"
  >,
): boolean {
  return (
    (thread.activityRunStatus ?? null) !== null ||
    LIVE_SHELL_STATUSES.has(thread.status) ||
    thread.pendingRuntimeRequest !== null ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0
  );
}

/**
 * A settled top-level thread settled before `beforeMs`. Shells that omit older settled threads
 * count every such thread, so the server and clients share this one rule.
 */
export function isOlderSettledThreadShell(
  thread: Pick<OrchestrationV2ThreadShell, "lineage" | "settledOverride" | "settledAt">,
  beforeMs: number,
): boolean {
  return (
    isListedThreadLineage(thread.lineage) &&
    thread.settledOverride === "settled" &&
    thread.settledAt !== null &&
    DateTime.toEpochMillis(thread.settledAt) < beforeMs
  );
}

export const OrchestrationV2OlderSettledCount = Schema.Struct({
  projectId: ProjectId,
  count: NonNegativeInt,
});

export type OrchestrationV2OlderSettledCount = typeof OrchestrationV2OlderSettledCount.Type;

/**
 * Snapshots that leave out older settled threads (`omitOlderSettled`) name the cut and count, per
 * project, every thread `isOlderSettledThreadShell` matches, sent or not. `asOfSequence` is the
 * snapshot's own sequence: the counts are exact until a later change.
 */
export const OrchestrationV2OlderSettledThreads = Schema.Struct({
  before: IsoDateTime,
  asOfSequence: NonNegativeInt,
  counts: Schema.Array(OrchestrationV2OlderSettledCount),
});

export type OrchestrationV2OlderSettledThreads = typeof OrchestrationV2OlderSettledThreads.Type;

export const OrchestrationV2ThreadShellSnapshot = Schema.Struct({
  schemaVersion: PositiveInt,
  snapshotSequence: NonNegativeInt,
  threads: Schema.Array(OrchestrationV2ThreadShell),
  archivedThreads: Schema.Array(OrchestrationV2ThreadShell),
});

export type OrchestrationV2ThreadShellSnapshot = typeof OrchestrationV2ThreadShellSnapshot.Type;

export const OrchestrationV2ShellSnapshot = Schema.Struct({
  ...OrchestrationV2ThreadShellSnapshot.fields,
  projects: Schema.Array(OrchestrationProjectShell),
  olderSettled: Schema.optionalKey(OrchestrationV2OlderSettledThreads),
});

export type OrchestrationV2ShellSnapshot = typeof OrchestrationV2ShellSnapshot.Type;

export const OrchestrationV2ShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationV2ShellSnapshot,
    resolvedRepositoryIdentityRoots: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("project.updated"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project.removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread.updated"),
    sequence: NonNegativeInt,
    location: Schema.Literals(["active", "archive"]),
    thread: OrchestrationV2ThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread.removed"),
    sequence: NonNegativeInt,
    location: Schema.Literals(["active", "archive"]),
    threadId: ThreadId,
  }),
]);

export type OrchestrationV2ShellStreamItem = typeof OrchestrationV2ShellStreamItem.Type;

export const OrchestrationV2StoredEvent = Schema.Struct({
  sequence: NonNegativeInt,
  commandId: Schema.NullOr(CommandId),
  event: OrchestrationV2DomainEvent,
});

export type OrchestrationV2StoredEvent = typeof OrchestrationV2StoredEvent.Type;
