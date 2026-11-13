// JSON wire codecs (DateTimeUtcFromString variants) for the schemas above.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OrchestrationMessageContext } from "./composerContext.ts";

import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  ContextHandoffId,
  MessageId,
  NodeId,
  ForwardCompatibleUnion,
  NonNegativeInt,
  PlanId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ThreadPullRequestLink } from "./threadPullRequest.ts";
import {
  ProviderApprovalFullAccessOverride,
  ProviderApprovalOption,
  ProviderRequestKind,
  UserInputAttachmentAnswerPayload,
} from "./providerPolicy.ts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
} from "./providerInstance.ts";

import {
  OrchestrationV2AppThread,
  OrchestrationV2ContextTransfer,
  OrchestrationV2CreationFields,
  OrchestrationV2IdleCompaction,
} from "./orchestrationV2Base.ts";

import {
  OrchestrationV2CheckpointScope,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderSessionDetached,
  OrchestrationV2ProviderThread,
  OrchestrationV2RemoteTaskChild,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2RunBackgroundWorkCancelled,
  OrchestrationV2Subagent,
} from "./orchestrationV2Runs.ts";

import {
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointFileSummary,
  OrchestrationV2CheckpointRollbackRequest,
  OrchestrationV2ContextHandoff,
  OrchestrationV2ConversationMessage,
  OrchestrationV2FileChangeDetail,
  OrchestrationV2ModelSwitch,
  OrchestrationV2Notification,
  OrchestrationV2PlanArtifact,
  OrchestrationV2PlanStep,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  OrchestrationV2UserMessageInputIntent,
} from "./orchestrationV2Turns.ts";

import {
  OrchestrationV2FileSearchResult,
  OrchestrationV2LinkRequestFields,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2SecretRequestFields,
  OrchestrationV2TurnItemBaseFields,
  OrchestrationV2WebSearchResult,
  projectedTurnItemArray,
  turnItemArray,
} from "./orchestrationV2TurnItems.ts";

import {
  OrchestrationV2EventBase,
  OrchestrationV2LatestVisibleMessageSummary,
  OrchestrationV2PendingRuntimeRequestSummary,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "./orchestrationV2Events.ts";

export const OrchestrationV2AppThreadJson = OrchestrationV2AppThread.mapFields((fields) => ({
  ...fields,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  settledAt: Schema.NullOr(Schema.DateTimeUtcFromString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  unsettledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  snoozedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  lastSnoozeWakeAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  pinnedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  lastVisitedAt: Schema.NullOr(Schema.DateTimeUtcFromString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  titleRegeneration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requestId: CommandId,
        startedAt: Schema.DateTimeUtcFromString,
      }),
    ),
  ),
  deletedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));

export type OrchestrationV2AppThreadJson = typeof OrchestrationV2AppThreadJson.Type;

export const OrchestrationV2RunJson = OrchestrationV2Run.mapFields((fields) => ({
  ...fields,
  requestedAt: Schema.DateTimeUtcFromString,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  workStartedAt: Schema.optional(Schema.DateTimeUtcFromString),
}));

export type OrchestrationV2RunJson = typeof OrchestrationV2RunJson.Type;

export const OrchestrationV2RunAttemptJson = OrchestrationV2RunAttempt.mapFields((fields) => ({
  ...fields,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));

export type OrchestrationV2RunAttemptJson = typeof OrchestrationV2RunAttemptJson.Type;

export const OrchestrationV2ExecutionNodeJson = OrchestrationV2ExecutionNode.mapFields(
  (fields) => ({
    ...fields,
    startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  }),
);

export type OrchestrationV2ExecutionNodeJson = typeof OrchestrationV2ExecutionNodeJson.Type;

export const OrchestrationV2SubagentJson = OrchestrationV2Subagent.mapFields((fields) => ({
  ...fields,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  updatedAt: Schema.DateTimeUtcFromString,
}));

export type OrchestrationV2SubagentJson = typeof OrchestrationV2SubagentJson.Type;

export const OrchestrationV2CheckpointScopeJson = OrchestrationV2CheckpointScope.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
  }),
);

export type OrchestrationV2CheckpointScopeJson = typeof OrchestrationV2CheckpointScopeJson.Type;

export const OrchestrationV2ProviderSessionJson = OrchestrationV2ProviderSession.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);

export type OrchestrationV2ProviderSessionJson = typeof OrchestrationV2ProviderSessionJson.Type;

const OrchestrationV2ProviderSessionDetachedJson =
  OrchestrationV2ProviderSessionDetached.mapFields((fields) => ({
    ...fields,
    detachedAt: Schema.DateTimeUtcFromString,
  }));

type OrchestrationV2ProviderSessionDetachedJson =
  typeof OrchestrationV2ProviderSessionDetachedJson.Type;

export const OrchestrationV2ProviderThreadJson = OrchestrationV2ProviderThread.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);

export type OrchestrationV2ProviderThreadJson = typeof OrchestrationV2ProviderThreadJson.Type;

export const OrchestrationV2ContextHandoffJson = OrchestrationV2ContextHandoff.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);

export type OrchestrationV2ContextHandoffJson = typeof OrchestrationV2ContextHandoffJson.Type;

export const OrchestrationV2ContextTransferJson = OrchestrationV2ContextTransfer.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
    consumedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  }),
);

export type OrchestrationV2ContextTransferJson = typeof OrchestrationV2ContextTransferJson.Type;

export const OrchestrationV2ProviderTurnJson = OrchestrationV2ProviderTurn.mapFields((fields) => ({
  ...fields,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));

export type OrchestrationV2ProviderTurnJson = typeof OrchestrationV2ProviderTurnJson.Type;

export const OrchestrationV2RuntimeRequestJson = OrchestrationV2RuntimeRequest.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    resolvedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  }),
);

export type OrchestrationV2RuntimeRequestJson = typeof OrchestrationV2RuntimeRequestJson.Type;

export const OrchestrationV2ConversationMessageJson = OrchestrationV2ConversationMessage.mapFields(
  (fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);

export type OrchestrationV2ConversationMessageJson =
  typeof OrchestrationV2ConversationMessageJson.Type;

export const OrchestrationV2CheckpointJson = OrchestrationV2Checkpoint.mapFields((fields) => ({
  ...fields,
  capturedAt: Schema.DateTimeUtcFromString,
}));

export type OrchestrationV2CheckpointJson = typeof OrchestrationV2CheckpointJson.Type;

const OrchestrationV2CheckpointRollbackRequestJson =
  OrchestrationV2CheckpointRollbackRequest.mapFields((fields) => ({
    ...fields,
    requestedAt: Schema.DateTimeUtcFromString,
  }));

const OrchestrationV2TurnItemJsonBaseFields = {
  ...OrchestrationV2TurnItemBaseFields,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  updatedAt: Schema.DateTimeUtcFromString,
} as const;

export const OrchestrationV2TurnItemJson = Schema.Union([
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("notification"),
    ...OrchestrationV2Notification.fields,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    ...OrchestrationV2CreationFields,
    type: Schema.Literal("user_message"),
    messageId: MessageId,
    scheduledTaskId: Schema.optional(ScheduledTaskId),
    senderThreadId: Schema.optional(ThreadId),
    idleCompaction: Schema.optional(OrchestrationV2IdleCompaction),
    workflowScript: OrchestrationV2ConversationMessage.fields.workflowScript,
    inputIntent: OrchestrationV2UserMessageInputIntent,
    text: Schema.String,
    context: Schema.optional(OrchestrationMessageContext),
    attachments: Schema.Array(ChatAttachment),
    modelSwitch: Schema.optional(OrchestrationV2ModelSwitch),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("assistant_message"),
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.optional(Schema.Array(ChatAttachment)),
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("reasoning"),
    text: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("proposed_plan"),
    planId: PlanId,
    markdown: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("todo_list"),
    planId: PlanId,
    steps: Schema.Array(OrchestrationV2PlanStep),
    explanation: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("user_input_request"),
    requestId: RuntimeRequestId,
    questions: Schema.Array(OrchestrationV2UserInputQuestion),
    questionAnswer: Schema.optional(UserInputAttachmentAnswerPayload),
    responseMode: Schema.optional(Schema.Literal("message")),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("file_change"),
    fileName: TrimmedNonEmptyString,
    additions: Schema.optional(NonNegativeInt),
    deletions: Schema.optional(NonNegativeInt),
    diffStr: Schema.optional(Schema.String),
    oldStr: Schema.optional(Schema.String),
    newStr: Schema.optional(Schema.String),
    changes: Schema.optional(Schema.Array(OrchestrationV2FileChangeDetail)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("command_execution"),
    input: Schema.String,
    output: Schema.optional(Schema.String),
    /** Set on the wire when output was withheld; fetch it with getTurnItem. */
    outputOmitted: Schema.optional(Schema.Boolean),
    outputIndicatesFailure: Schema.optional(Schema.Boolean),
    exitCode: Schema.optional(Schema.Int),
    /** Set when the command is a monitor, so background work lists it as a monitor. */
    monitor: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("file_search"),
    pattern: Schema.optional(Schema.String),
    results: Schema.optional(Schema.Array(OrchestrationV2FileSearchResult)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("web_search"),
    patterns: Schema.optional(Schema.Array(Schema.String)),
    results: Schema.optional(Schema.Array(OrchestrationV2WebSearchResult)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("approval_request"),
    requestId: RuntimeRequestId,
    requestKind: ProviderRequestKind,
    prompt: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
    fullAccessOverride: Schema.optional(ProviderApprovalFullAccessOverride),
    appName: Schema.optional(Schema.String),
    options: Schema.optional(Schema.Array(ProviderApprovalOption)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("checkpoint"),
    checkpointId: CheckpointId,
    scopeId: CheckpointScopeId,
    files: Schema.Array(OrchestrationV2CheckpointFileSummary),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("run_interrupt_request"),
    message: Schema.String,
    unresponsiveAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("run_interrupt_result"),
    message: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("system_notice"),
    message: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("error"),
    failure: OrchestrationV2ProviderFailure,
    retry: Schema.optional(OrchestrationV2ProviderRetry),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("compaction"),
    driver: Schema.NullOr(ProviderDriverKind),
    summary: Schema.optional(Schema.String),
    beforeTokenCount: Schema.optional(NonNegativeInt),
    afterTokenCount: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("handoff"),
    contextHandoffId: ContextHandoffId,
    fromProviderThreadIds: Schema.Array(ProviderThreadId),
    toProviderThreadId: ProviderThreadId,
    fromProviderInstanceIds: Schema.Array(ProviderInstanceId),
    toProviderInstanceId: ProviderInstanceId,
    fromModelSelections: Schema.optional(Schema.Array(ModelSelection)),
    toModel: Schema.optional(Schema.String),
    strategy: Schema.Literals([
      "delta_since_target_last_seen",
      "fork_delta_summary",
      "full_thread_summary",
      "checkpoint_summary",
      "manual_context",
    ]),
    summary: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("fork"),
    source: Schema.Union([
      Schema.Struct({ type: Schema.Literal("run"), threadId: ThreadId, runId: RunId }),
      Schema.Struct({ type: Schema.Literal("node"), nodeId: NodeId }),
      Schema.Struct({
        type: Schema.Literal("provider_thread"),
        providerThreadId: ProviderThreadId,
        providerTurnId: Schema.optional(ProviderTurnId),
      }),
    ]),
    targetThreadId: ThreadId,
    providerThreadId: Schema.optional(ProviderThreadId),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("thread_created"),
    targetThreadId: ThreadId,
    targetRunId: Schema.NullOr(RunId),
    targetProviderInstanceId: ProviderInstanceId,
    targetModel: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    ...OrchestrationV2SecretRequestFields,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    ...OrchestrationV2LinkRequestFields,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("subagent"),
    subagentId: NodeId,
    origin: Schema.Literals(["provider_native", "app_owned"]),
    driver: ProviderDriverKind,
    providerInstanceId: ProviderInstanceId,
    childThreadId: Schema.NullOr(ThreadId),
    remoteChild: Schema.optional(OrchestrationV2RemoteTaskChild),
    prompt: Schema.String,
    progress: Schema.optional(Schema.String),
    result: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemJsonBaseFields,
    type: Schema.Literal("dynamic_tool"),
    toolName: Schema.NullOr(TrimmedNonEmptyString),
    viewedImagePath: Schema.optional(TrimmedNonEmptyString),
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
    /** Set on the wire when output was withheld; fetch it with getTurnItem. */
    outputOmitted: Schema.optional(Schema.Boolean),
  }),
]);

export type OrchestrationV2TurnItemJson = typeof OrchestrationV2TurnItemJson.Type;

const OrchestrationV2ProjectedTurnItemJson = OrchestrationV2ProjectedTurnItem.mapFields(
  (fields) => ({
    ...fields,
    item: OrchestrationV2TurnItemJson,
  }),
);

type OrchestrationV2ProjectedTurnItemJson = typeof OrchestrationV2ProjectedTurnItemJson.Type;

export const OrchestrationV2ThreadProjectionJson = OrchestrationV2ThreadProjection.mapFields(
  (fields) => ({
    ...fields,
    thread: OrchestrationV2AppThreadJson,
    runs: Schema.Array(OrchestrationV2RunJson),
    attempts: Schema.Array(OrchestrationV2RunAttemptJson),
    nodes: Schema.Array(OrchestrationV2ExecutionNodeJson),
    subagents: Schema.Array(OrchestrationV2SubagentJson),
    providerSessions: Schema.Array(OrchestrationV2ProviderSessionJson),
    providerThreads: Schema.Array(OrchestrationV2ProviderThreadJson),
    providerTurns: Schema.Array(OrchestrationV2ProviderTurnJson),
    runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequestJson),
    messages: Schema.Array(OrchestrationV2ConversationMessageJson),
    plans: Schema.Array(OrchestrationV2PlanArtifact),
    turnItems: turnItemArray(OrchestrationV2TurnItemJson),
    checkpointScopes: Schema.Array(OrchestrationV2CheckpointScopeJson),
    checkpoints: Schema.Array(OrchestrationV2CheckpointJson),
    contextHandoffs: Schema.Array(OrchestrationV2ContextHandoffJson),
    contextTransfers: Schema.Array(OrchestrationV2ContextTransferJson),
    visibleTurnItems: projectedTurnItemArray(
      OrchestrationV2ProjectedTurnItemJson,
      OrchestrationV2ProjectedTurnItemJson.mapFields((fields) => ({
        ...fields,
        item: ForwardCompatibleUnion(OrchestrationV2TurnItemJson.members, "type"),
      })),
    ),
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);

export type OrchestrationV2ThreadProjectionJson = typeof OrchestrationV2ThreadProjectionJson.Type;

const OrchestrationV2PendingRuntimeRequestSummaryJson =
  OrchestrationV2PendingRuntimeRequestSummary.mapFields((fields) => ({
    ...fields,
    createdAt: Schema.DateTimeUtcFromString,
  }));

type OrchestrationV2PendingRuntimeRequestSummaryJson =
  typeof OrchestrationV2PendingRuntimeRequestSummaryJson.Type;

const OrchestrationV2LatestVisibleMessageSummaryJson =
  OrchestrationV2LatestVisibleMessageSummary.mapFields((fields) => ({
    ...fields,
    updatedAt: Schema.DateTimeUtcFromString,
  }));

type OrchestrationV2LatestVisibleMessageSummaryJson =
  typeof OrchestrationV2LatestVisibleMessageSummaryJson.Type;

export const OrchestrationV2ThreadShellJson = OrchestrationV2ThreadShell.mapFields((fields) => ({
  ...fields,
  latestRunRequestedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  latestRunStartedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  latestRunCompletedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  activityRunStartedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  pendingRuntimeRequest: Schema.NullOr(OrchestrationV2PendingRuntimeRequestSummaryJson),
  latestVisibleMessage: Schema.NullOr(OrchestrationV2LatestVisibleMessageSummaryJson),
  latestUserMessageAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  latestUserAuthoredMessageAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  settledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  unsettledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  snoozedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  pinnedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  lastVisitedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  titleRegeneration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requestId: CommandId,
        startedAt: Schema.DateTimeUtcFromString,
      }),
    ),
  ),
  deletedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));

export type OrchestrationV2ThreadShellJson = typeof OrchestrationV2ThreadShellJson.Type;

export const OrchestrationV2ShellSnapshotJson = OrchestrationV2ShellSnapshot.mapFields(
  (fields) => ({
    ...fields,
    threads: Schema.Array(OrchestrationV2ThreadShellJson),
    archivedThreads: Schema.Array(OrchestrationV2ThreadShellJson),
  }),
);

export type OrchestrationV2ShellSnapshotJson = typeof OrchestrationV2ShellSnapshotJson.Type;

const OrchestrationV2JsonEventBaseFields = {
  ...OrchestrationV2EventBase.fields,
  occurredAt: Schema.DateTimeUtcFromString,
} as const;

export const OrchestrationV2DomainEventJson = Schema.Union([
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: OrchestrationV2AppThreadJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
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
      "thread.pull-request-synced",
      "thread.metadata-updated",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.guest-share-updated",
    ]),
    payload: OrchestrationV2AppThreadJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("thread.pull-request-link-updated"),
    payload: ThreadPullRequestLink,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("run.created"),
    payload: OrchestrationV2RunJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("run.updated"),
    payload: OrchestrationV2RunJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("run.background-work-cancelled"),
    payload: OrchestrationV2RunBackgroundWorkCancelled,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("run-attempt.created"),
    payload: OrchestrationV2RunAttemptJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("run-attempt.updated"),
    payload: OrchestrationV2RunAttemptJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("node.updated"),
    payload: OrchestrationV2ExecutionNodeJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("subagent.updated"),
    payload: OrchestrationV2SubagentJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literals(["provider-session.attached", "provider-session.updated"]),
    payload: OrchestrationV2ProviderSessionJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("provider-session.detached"),
    payload: OrchestrationV2ProviderSessionDetachedJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("provider-thread.updated"),
    payload: OrchestrationV2ProviderThreadJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("provider-turn.updated"),
    payload: OrchestrationV2ProviderTurnJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("runtime-request.updated"),
    payload: OrchestrationV2RuntimeRequestJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("message.updated"),
    payload: OrchestrationV2ConversationMessageJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("turn-item.updated"),
    payload: OrchestrationV2TurnItemJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("plan.updated"),
    payload: OrchestrationV2PlanArtifact,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("checkpoint-scope.created"),
    payload: OrchestrationV2CheckpointScopeJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("checkpoint.captured"),
    payload: OrchestrationV2CheckpointJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("checkpoint.rollback-requested"),
    payload: OrchestrationV2CheckpointRollbackRequestJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("context-handoff.updated"),
    payload: OrchestrationV2ContextHandoffJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("context-transfer.created"),
    payload: OrchestrationV2ContextTransferJson,
  }),
  Schema.Struct({
    ...OrchestrationV2JsonEventBaseFields,
    type: Schema.Literal("context-transfer.updated"),
    payload: OrchestrationV2ContextTransferJson,
  }),
]);

export type OrchestrationV2DomainEventJson = typeof OrchestrationV2DomainEventJson.Type;
