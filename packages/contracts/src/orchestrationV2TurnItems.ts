// Turn-item fields, the turn-item union and its projections.
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { OrchestrationMessageContext } from "./composerContext.ts";

import {
  CheckpointId,
  CheckpointScopeId,
  ContextHandoffId,
  MessageId,
  EnvironmentId,
  NodeId,
  ForwardCompatibleUnionArray,
  hasUnknownUnionTag,
  isUnknownUnionMember,
  NonNegativeInt,
  PlanId,
  PositiveInt,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { AuthMcpClientAccess } from "./auth.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
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
  ToolActivitySurface,
  ToolActivityIcon,
  ToolActivitySource,
} from "./providerRuntime.ts";

import {
  OrchestrationV2CreationFields,
  OrchestrationV2IdleCompaction,
  OrchestrationV2ProviderRef,
} from "./orchestrationV2Base.ts";

import {
  DedupedBodyMarker,
  OrchestrationV2RemoteTaskChild,
} from "./orchestrationV2Runs.ts";

import {
  OrchestrationV2CheckpointFileSummary,
  OrchestrationV2CheckpointFileTotals,
  OrchestrationV2ConversationMessage,
  OrchestrationV2FileChangeDetail,
  OrchestrationV2ModelSwitch,
  OrchestrationV2Notification,
  OrchestrationV2PlanStep,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2UserInputQuestion,
  OrchestrationV2UserMessageInputIntent,
} from "./orchestrationV2Turns.ts";

export const OrchestrationV2TurnItemBaseFields = {
  /** Wire-only cursor for collapsed work; persisted items keep their complete history. */
  deferredWork: Schema.optionalKey(
    Schema.Struct({
      cursor: TrimmedNonEmptyString,
      itemCount: PositiveInt,
      lastOrdinal: NonNegativeInt,
    }),
  ),
  toolNonExecutionKind: Schema.optional(Schema.String),
  toolSurface: Schema.optional(ToolActivitySurface),
  toolIcon: Schema.optional(ToolActivityIcon),
  toolSource: Schema.optional(ToolActivitySource),
  id: TurnItemId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: Schema.NullOr(NodeId),
  providerThreadId: Schema.NullOr(ProviderThreadId),
  providerTurnId: Schema.NullOr(ProviderTurnId),
  nativeItemRef: Schema.NullOr(OrchestrationV2ProviderRef),
  parentItemId: Schema.NullOr(TurnItemId),
  ordinal: NonNegativeInt,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
  updatedAt: Schema.DateTimeUtc,
} as const;

export const OrchestrationV2FileSearchResult = Schema.Struct({
  fileName: TrimmedNonEmptyString,
  line: Schema.optional(PositiveInt),
  column: Schema.optional(PositiveInt),
  preview: Schema.optional(Schema.String),
});

export type OrchestrationV2FileSearchResult = typeof OrchestrationV2FileSearchResult.Type;

export const OrchestrationV2WebSearchResult = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.optional(TrimmedNonEmptyString),
  snippet: Schema.optional(Schema.String),
});

export type OrchestrationV2WebSearchResult = typeof OrchestrationV2WebSearchResult.Type;

export const OrchestrationV2SecretRequestStatus = Schema.Literals([
  "pending",
  "saved",
  "declined",
  "cancelled",
]);

export type OrchestrationV2SecretRequestStatus = typeof OrchestrationV2SecretRequestStatus.Type;

/** `file`: the value goes to an owner-only file the agent's shell commands can read. */
export const OrchestrationV2SecretRequestDelivery = Schema.Literal("file");

export const OrchestrationV2SecretRequestFields = {
  type: Schema.Literal("secret_request"),
  label: TrimmedNonEmptyString,
  reason: Schema.String,
  placeholder: Schema.optional(Schema.String),
  delivery: Schema.optional(OrchestrationV2SecretRequestDelivery),
  secretStatus: OrchestrationV2SecretRequestStatus,
} as const;

export const OrchestrationV2LinkRequestStatus = Schema.Literals([
  "pending",
  "linked",
  "declined",
  "cancelled",
  "failed",
]);

export type OrchestrationV2LinkRequestStatus = typeof OrchestrationV2LinkRequestStatus.Type;

/**
 * An agent asked the user to link another environment. The user picks the
 * access; the pairing code never passes through orchestration, so the item
 * carries only what was asked and how it ended.
 */
export const OrchestrationV2LinkRequestFields = {
  type: Schema.Literal("link_request"),
  /** The address the agent named, if it named one. */
  url: Schema.optional(TrimmedNonEmptyString),
  reason: Schema.String,
  /**
   * The environment the agent named, or the one answering at `url`. Without
   * either the user picks the machine in the card.
   */
  environmentId: Schema.optional(EnvironmentId),
  label: Schema.optional(Schema.String),
  /** A phrase from the user's words, such as "vps", that preselects a machine. */
  hint: Schema.optional(Schema.String),
  /** The access the agent suggested; the user's choice is final. */
  requestedAccess: Schema.optional(AuthMcpClientAccess),
  linkStatus: OrchestrationV2LinkRequestStatus,
  linkedEnvironmentId: Schema.optional(EnvironmentId),
  linkedLabel: Schema.optional(Schema.String),
  linkedAccess: Schema.optional(AuthMcpClientAccess),
  failure: Schema.optional(Schema.String),
} as const;

export const OrchestrationV2TurnItem = Schema.Union([
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("notification"),
    ...OrchestrationV2Notification.fields,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    ...OrchestrationV2CreationFields,
    type: Schema.Literal("user_message"),
    messageId: MessageId,
    scheduledTaskId: Schema.optional(ScheduledTaskId),
    senderThreadId: Schema.optional(ThreadId),
    idleCompaction: Schema.optional(OrchestrationV2IdleCompaction),
    workflowScript: OrchestrationV2ConversationMessage.fields.workflowScript,
    inputIntent: OrchestrationV2UserMessageInputIntent,
    text: Schema.String,
    /** Same as the text of message `messageId`. */
    textOmitted: DedupedBodyMarker,
    context: Schema.optional(OrchestrationMessageContext),
    attachments: Schema.Array(ChatAttachment),
    modelSwitch: Schema.optional(OrchestrationV2ModelSwitch),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("assistant_message"),
    messageId: MessageId,
    text: Schema.String,
    textOmitted: DedupedBodyMarker,
    attachments: Schema.optional(Schema.Array(ChatAttachment)),
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("reasoning"),
    text: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("proposed_plan"),
    planId: PlanId,
    markdown: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("todo_list"),
    planId: PlanId,
    steps: Schema.Array(OrchestrationV2PlanStep),
    explanation: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("user_input_request"),
    requestId: RuntimeRequestId,
    questions: Schema.Array(OrchestrationV2UserInputQuestion),
    questionAnswer: Schema.optional(UserInputAttachmentAnswerPayload),
    responseMode: Schema.optional(Schema.Literal("message")),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
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
    ...OrchestrationV2TurnItemBaseFields,
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
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("file_search"),
    pattern: Schema.optional(Schema.String),
    results: Schema.optional(Schema.Array(OrchestrationV2FileSearchResult)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("web_search"),
    patterns: Schema.optional(Schema.Array(Schema.String)),
    results: Schema.optional(Schema.Array(OrchestrationV2WebSearchResult)),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
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
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("checkpoint"),
    checkpointId: CheckpointId,
    scopeId: CheckpointScopeId,
    files: Schema.Array(OrchestrationV2CheckpointFileSummary),
    filesTotal: Schema.optionalKey(OrchestrationV2CheckpointFileTotals),
    /** Same as the files of checkpoint `checkpointId`. */
    filesOmitted: DedupedBodyMarker,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("run_interrupt_request"),
    message: Schema.String,
    /** Set when the provider did not confirm the stop in time; clients then offer Force stop. */
    unresponsiveAt: Schema.optionalKey(Schema.DateTimeUtc),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("run_interrupt_result"),
    message: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("system_notice"),
    message: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("error"),
    failure: OrchestrationV2ProviderFailure,
    retry: Schema.optional(OrchestrationV2ProviderRetry),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("compaction"),
    driver: Schema.NullOr(ProviderDriverKind),
    summary: Schema.optional(Schema.String),
    beforeTokenCount: Schema.optional(NonNegativeInt),
    afterTokenCount: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
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
    ...OrchestrationV2TurnItemBaseFields,
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
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("thread_created"),
    targetThreadId: ThreadId,
    targetRunId: Schema.NullOr(RunId),
    targetProviderInstanceId: ProviderInstanceId,
    targetModel: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    ...OrchestrationV2SecretRequestFields,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    ...OrchestrationV2LinkRequestFields,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
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
    /** Same as the prompt and result of subagent `subagentId`. */
    promptOmitted: DedupedBodyMarker,
    resultOmitted: DedupedBodyMarker,
  }),
  Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("dynamic_tool"),
    toolName: Schema.NullOr(TrimmedNonEmptyString),
    viewedImagePath: Schema.optional(TrimmedNonEmptyString),
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
    /** Set on the wire when output was withheld; fetch it with getTurnItem. */
    outputOmitted: Schema.optional(Schema.Boolean),
  }),
]);

export type OrchestrationV2TurnItem = typeof OrchestrationV2TurnItem.Type;

export const isUnknownTurnItem = hasUnknownUnionTag(OrchestrationV2TurnItem.members, "type");

export const turnItemArray = <Members extends ReadonlyArray<Schema.Top & { readonly fields: object }>>(
  union: Schema.Union<Members>,
) => ForwardCompatibleUnionArray(union.members, "type");

export const projectedTurnItemArray = <Row extends Schema.Top, Item extends Schema.Top>(
  row: Row,
  rowWithUnknownItem: Item,
) =>
  Schema.Array(rowWithUnknownItem).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(row)),
      SchemaTransformation.transform<ReadonlyArray<Row["Type"]>, ReadonlyArray<Item["Type"]>>({
        decode: (rows) =>
          rows.filter(
            (projected) => !isUnknownUnionMember((projected as { readonly item: unknown }).item),
          ) as ReadonlyArray<Row["Type"]>,
        encode: (rows) => rows,
      }),
    ),
  );

export const OrchestrationV2ProjectedTurnItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  sourceItemId: TurnItemId,
  item: OrchestrationV2TurnItem,
});

export type OrchestrationV2ProjectedTurnItem = typeof OrchestrationV2ProjectedTurnItem.Type;
