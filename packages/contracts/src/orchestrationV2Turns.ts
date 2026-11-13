// Provider turns, runtime requests, messages, plans and checkpoints.
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

import { OrchestrationMessageContext } from "./composerContext.ts";

import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  ContextHandoffId,
  ContextTransferId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PlanId,
  PositiveInt,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  ProviderApprovalDecision,
  ProviderRequestKind,
  ProviderUserInputAnswers,
} from "./providerPolicy.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { TurnTokenUsage } from "./providerRuntime.ts";

import {
  OrchestrationV2CreationFields,
  OrchestrationV2IdleCompaction,
  OrchestrationV2ProviderRef,
  OrchestrationV2ProviderTurnTokenUsage,
} from "./orchestrationV2Base.ts";

import {
  kindUnionWithFallback,
} from "./orchestrationV2Runs.ts";

export const OrchestrationV2HistoricalMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  runStatus: Schema.optional(Schema.String),
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  itemId: TurnItemId,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  status: Schema.String,
  kind: Schema.String,
});

export type OrchestrationV2HistoricalMessage = typeof OrchestrationV2HistoricalMessage.Type;

export const OrchestrationV2ContextHandoff = Schema.Struct({
  id: ContextHandoffId,
  transferId: Schema.optional(Schema.NullOr(ContextTransferId)),
  threadId: ThreadId,
  targetRunId: RunId,
  fromProviderThreadIds: Schema.Array(ProviderThreadId),
  toProviderThreadId: ProviderThreadId,
  coveredRunOrdinals: Schema.Struct({
    from: PositiveInt,
    to: PositiveInt,
  }),
  strategy: Schema.Literals([
    "delta_since_target_last_seen",
    "fork_delta_summary",
    "full_thread_summary",
    "checkpoint_summary",
    "manual_context",
  ]),
  status: Schema.Literals(["pending", "ready", "failed", "superseded"]),
  summaryMessageId: Schema.NullOr(MessageId),
  summaryText: Schema.String,
  history: Schema.optional(
    Schema.Struct({
      messages: Schema.Array(OrchestrationV2HistoricalMessage),
      coverage: Schema.String,
      omittedItems: NonNegativeInt,
      omittedItemIds: Schema.optional(Schema.Array(TurnItemId)),
    }),
  ),
  delivery: Schema.optional(
    Schema.Struct({
      nativeThreadId: Schema.String,
      status: Schema.Literals(["pending", "injected", "inline"]),
      itemIds: Schema.Array(TurnItemId),
      omittedItemIds: Schema.optional(Schema.Array(TurnItemId)),
    }),
  ),
  detailInTurnItem: Schema.optional(Schema.Literal(true)),
  createdByProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});

export type OrchestrationV2ContextHandoff = typeof OrchestrationV2ContextHandoff.Type;

export const OrchestrationV2ProviderTurn = Schema.Struct({
  id: ProviderTurnId,
  providerThreadId: ProviderThreadId,
  nodeId: NodeId,
  runAttemptId: Schema.NullOr(RunAttemptId),
  nativeTurnRef: Schema.NullOr(OrchestrationV2ProviderRef),
  ordinal: PositiveInt,
  status: Schema.Literals([
    "pending",
    "running",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
  ]),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
  tokenUsage: Schema.optional(OrchestrationV2ProviderTurnTokenUsage),
  turnTokenUsage: Schema.optional(TurnTokenUsage),
});

export type OrchestrationV2ProviderTurn = typeof OrchestrationV2ProviderTurn.Type;

/** Codex goals can span multiple native turns within one attempt. */
export function latestProviderTurnForAttempt<
  Turn extends Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "ordinal">,
>(
  providerTurns: ReadonlyArray<Turn>,
  attemptId: RunAttemptId | null | undefined,
): Turn | undefined {
  let latest: Turn | undefined;
  for (const turn of providerTurns) {
    if (attemptId == null || turn.runAttemptId !== attemptId) continue;
    if (latest === undefined || turn.ordinal > latest.ordinal) latest = turn;
  }
  return latest;
}

export const OrchestrationV2RuntimeRequest = Schema.Struct({
  id: RuntimeRequestId,
  nodeId: NodeId,
  providerTurnId: Schema.NullOr(ProviderTurnId),
  nativeRequestRef: Schema.NullOr(OrchestrationV2ProviderRef),
  kind: Schema.Union([
    ProviderRequestKind,
    Schema.Literals(["dynamic_tool_call", "user_input", "auth_refresh"]),
  ]),
  status: Schema.Literals(["pending", "resolved", "expired", "cancelled"]),
  responseCapability: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("live"),
      providerSessionId: ProviderSessionId,
      supportsFeedback: Schema.optional(Schema.Boolean),
    }),
    Schema.Struct({ type: Schema.Literal("message") }),
    Schema.Struct({ type: Schema.Literal("not_resumable"), reason: Schema.String }),
  ]),
  createdAt: Schema.DateTimeUtc,
  resolvedAt: Schema.NullOr(Schema.DateTimeUtc),
  decision: Schema.optional(ProviderApprovalDecision),
  feedback: Schema.optional(Schema.String),
  answers: Schema.optional(ProviderUserInputAnswers),
});

export type OrchestrationV2RuntimeRequest = typeof OrchestrationV2RuntimeRequest.Type;

const SubagentNotificationSource = Schema.Struct({
  kind: Schema.Literal("subagent"),
  childThreadId: Schema.optional(ThreadId),
});

const CommandNotificationSource = Schema.Struct({ kind: Schema.Literal("command") });

/** Encode legacy background_command/background_task shapes first so older clients accept command/subagent sources. */
export const OrchestrationV2NotificationSource = kindUnionWithFallback(
  [
    Schema.Struct({
      kind: Schema.Literal("delegated_task"),
      taskIds: Schema.Array(NodeId),
      childThreadId: Schema.optional(ThreadId),
    }),
    Schema.Struct({
      kind: Schema.Literal("background_task"),
      work: Schema.Literal("subagent"),
      childThreadId: Schema.optional(ThreadId),
    }).pipe(
      Schema.decodeTo(Schema.toType(SubagentNotificationSource), {
        decode: SchemaGetter.transform(({ childThreadId }) =>
          childThreadId === undefined
            ? { kind: "subagent" as const }
            : { kind: "subagent" as const, childThreadId },
        ),
        encode: SchemaGetter.transform(({ childThreadId }) => ({
          kind: "background_task" as const,
          work: "subagent" as const,
          ...(childThreadId === undefined ? {} : { childThreadId }),
        })),
      }),
    ),
    Schema.Struct({ kind: Schema.Literal("background_command").transform("command") }),
    SubagentNotificationSource,
    CommandNotificationSource,
    Schema.Struct({ kind: Schema.Literal("monitor") }),
    Schema.Struct({ kind: Schema.Literal("background_task") }),
    Schema.Struct({ kind: Schema.Literal("system") }),
  ],
  (kind) => Schema.Struct({ kind }),
  () => ({ kind: "background_task" }),
);

export type OrchestrationV2NotificationSource = typeof OrchestrationV2NotificationSource.Type;

export const OrchestrationV2Notification = Schema.Struct({
  source: OrchestrationV2NotificationSource,
  outcome: Schema.Literals(["completed", "failed", "cancelled", "updated", "unknown"]),
  summary: TrimmedNonEmptyString,
  detail: Schema.optional(Schema.String),
});

export type OrchestrationV2Notification = typeof OrchestrationV2Notification.Type;

export const OrchestrationV2ConversationMessage = Schema.Struct({
  notification: Schema.optional(OrchestrationV2Notification),
  ...OrchestrationV2CreationFields,
  scheduledTaskId: Schema.optional(ScheduledTaskId),
  senderThreadId: Schema.optional(ThreadId),
  idleCompaction: Schema.optional(OrchestrationV2IdleCompaction),
  /**
   * The message is the script a provider-native workflow run executes, not prose. Clients show
   * the workflow's opening instead and keep the script behind a disclosure.
   */
  workflowScript: Schema.optional(Schema.Boolean),
  id: MessageId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: Schema.NullOr(NodeId),
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  context: Schema.optional(OrchestrationMessageContext),
  attachments: Schema.Array(ChatAttachment),
  streaming: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  delegatedCompletion: Schema.optional(
    Schema.Struct({
      parentRunId: RunId,
      generation: PositiveInt,
      taskIds: Schema.Array(NodeId),
    }),
  ),
});

export type OrchestrationV2ConversationMessage = typeof OrchestrationV2ConversationMessage.Type;

export const OrchestrationV2PlanStep = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "running", "completed"]),
  durationAnchorAt: Schema.optional(IsoDateTime),
  durationMs: Schema.optional(NonNegativeInt),
});

export type OrchestrationV2PlanStep = typeof OrchestrationV2PlanStep.Type;

export const OrchestrationV2UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      description: TrimmedNonEmptyString,
      value: Schema.optional(Schema.String),
      preview: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});

export type OrchestrationV2UserInputQuestion = typeof OrchestrationV2UserInputQuestion.Type;

const OrchestrationV2PlanArtifactBaseFields = {
  id: PlanId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: NodeId,
  status: Schema.Literals(["draft", "active", "completed", "superseded"]),
  detailInTurnItem: Schema.optional(Schema.Literal(true)),
} as const;

export const OrchestrationV2PlanArtifact = Schema.Union([
  Schema.Struct({
    ...OrchestrationV2PlanArtifactBaseFields,
    kind: Schema.Literal("proposed_plan"),
    markdown: Schema.String,
  }),
  Schema.Struct({
    ...OrchestrationV2PlanArtifactBaseFields,
    kind: Schema.Literal("todo_list"),
    steps: Schema.Array(OrchestrationV2PlanStep),
    explanation: Schema.optional(Schema.String),
  }),
]);

export type OrchestrationV2PlanArtifact = typeof OrchestrationV2PlanArtifact.Type;

export const OrchestrationV2CheckpointFileSummary = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});

export type OrchestrationV2CheckpointFileSummary = typeof OrchestrationV2CheckpointFileSummary.Type;

/** Sent only when the wire carries a prefix of `files`; the totals cover the full list. */
export const OrchestrationV2CheckpointFileTotals = Schema.Struct({
  count: NonNegativeInt,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});

export type OrchestrationV2CheckpointFileTotals = typeof OrchestrationV2CheckpointFileTotals.Type;

export const OrchestrationV2Checkpoint = Schema.Struct({
  id: CheckpointId,
  threadId: ThreadId,
  scopeId: CheckpointScopeId,
  runId: Schema.NullOr(RunId),
  nodeId: NodeId,
  parentCheckpointId: Schema.NullOr(CheckpointId),
  ordinalWithinScope: NonNegativeInt,
  appRunOrdinal: Schema.NullOr(PositiveInt),
  ref: CheckpointRef,
  status: Schema.Literals(["ready", "missing", "error", "stale"]),
  files: Schema.Array(OrchestrationV2CheckpointFileSummary),
  filesTotal: Schema.optionalKey(OrchestrationV2CheckpointFileTotals),
  capturedAt: Schema.DateTimeUtc,
});

export type OrchestrationV2Checkpoint = typeof OrchestrationV2Checkpoint.Type;

export const OrchestrationV2CheckpointRollbackRequest = Schema.Struct({
  scopeId: CheckpointScopeId,
  checkpointId: CheckpointId,
  requestedAt: Schema.DateTimeUtc,
});

export type OrchestrationV2CheckpointRollbackRequest =
  typeof OrchestrationV2CheckpointRollbackRequest.Type;

export class OrchestrationV2CheckpointUnavailableError extends Schema.TaggedError<OrchestrationV2CheckpointUnavailableError>()(
  "OrchestrationV2CheckpointUnavailableError",
  {
    threadId: ThreadId,
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Rollback target ${this.target} is unavailable for thread ${this.threadId}.`;
  }
}

export const OrchestrationV2TurnItemStatus = Schema.Literals([
  "idle",
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export type OrchestrationV2TurnItemStatus = typeof OrchestrationV2TurnItemStatus.Type;

export const OrchestrationV2FileChangeDetail = Schema.Struct({
  operation: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  oldPath: Schema.optional(TrimmedNonEmptyString),
  fileType: Schema.optional(TrimmedNonEmptyString),
  mimeType: Schema.optional(TrimmedNonEmptyString),
});

export type OrchestrationV2FileChangeDetail = typeof OrchestrationV2FileChangeDetail.Type;

export const OrchestrationV2ProviderFailureClass = Schema.Literals([
  "usage_limit",
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);

export type OrchestrationV2ProviderFailureClass = typeof OrchestrationV2ProviderFailureClass.Type;

const OrchestrationV2ProviderFailureMessage = TrimmedNonEmptyString.check(
  Schema.isMaxLength(4_096),
);

const OrchestrationV2ProviderFailureCode = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** Producers must redact credentials before construction. */
export const OrchestrationV2ProviderFailure = Schema.Struct({
  class: OrchestrationV2ProviderFailureClass,
  message: OrchestrationV2ProviderFailureMessage,
  code: Schema.NullOr(OrchestrationV2ProviderFailureCode),
  retryable: Schema.NullOr(Schema.Boolean),
  resetAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});

export type OrchestrationV2ProviderFailure = typeof OrchestrationV2ProviderFailure.Type;

export const OrchestrationV2ProviderRetry = Schema.Struct({
  attempt: PositiveInt,
  maxAttempts: Schema.NullOr(PositiveInt),
  retryDelayMs: Schema.NullOr(NonNegativeInt),
});

export type OrchestrationV2ProviderRetry = typeof OrchestrationV2ProviderRetry.Type;

export const OrchestrationV2UserMessageInputIntent = Schema.Literals([
  "turn_start",
  "queued_turn",
  "steer",
  "promoted_queued_to_steer",
]);

export type OrchestrationV2UserMessageInputIntent =
  typeof OrchestrationV2UserMessageInputIntent.Type;

/** A same-harness model or effort change that took effect with this message. */
export const OrchestrationV2ModelSwitch = Schema.Struct({
  from: ModelSelection,
  to: ModelSelection,
});

export type OrchestrationV2ModelSwitch = typeof OrchestrationV2ModelSwitch.Type;
