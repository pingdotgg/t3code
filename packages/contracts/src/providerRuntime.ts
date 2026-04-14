import { Schema } from "effect";
import {
  EventId,
  IsoDateTime,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ProviderKind } from "./orchestration";
import { CanonicalToolLifecycleData } from "./toolLifecycle";
export { ThreadTokenUsageSnapshot } from "./threadUsage";
import { ThreadTokenUsageSnapshot } from "./threadUsage";
export { ProviderUserInputAnswers, UserInputQuestion } from "./userInput";
import { ProviderUserInputAnswers, UserInputQuestion } from "./userInput";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

const RuntimeEventRawSource = Schema.Literals([
  "codex.app-server.notification",
  "codex.app-server.request",
  "codex.eventmsg",
  "claude.sdk.message",
  "claude.sdk.permission",
  "codex.sdk.thread-event",
]);
export type RuntimeEventRawSource = typeof RuntimeEventRawSource.Type;

export const RuntimeEventRaw = Schema.Struct({
  source: RuntimeEventRawSource,
  method: Schema.optional(TrimmedNonEmptyStringSchema),
  messageType: Schema.optional(TrimmedNonEmptyStringSchema),
  payload: Schema.Unknown,
});
export type RuntimeEventRaw = typeof RuntimeEventRaw.Type;

const ProviderRequestId = TrimmedNonEmptyStringSchema;
export type ProviderRequestId = typeof ProviderRequestId.Type;

const ProviderRefs = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyStringSchema),
  providerItemId: Schema.optional(ProviderItemId),
  providerRequestId: Schema.optional(ProviderRequestId),
});
export type ProviderRefs = typeof ProviderRefs.Type;

const RuntimeSessionState = Schema.Literals([
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);
export type RuntimeSessionState = typeof RuntimeSessionState.Type;

const RuntimeThreadState = Schema.Literals([
  "active",
  "idle",
  "archived",
  "closed",
  "compacted",
  "error",
]);
export type RuntimeThreadState = typeof RuntimeThreadState.Type;

const RuntimeTurnState = Schema.Literals(["completed", "failed", "interrupted", "cancelled"]);
export type RuntimeTurnState = typeof RuntimeTurnState.Type;

const RuntimePlanStepStatus = Schema.Literals(["pending", "inProgress", "completed"]);
export type RuntimePlanStepStatus = typeof RuntimePlanStepStatus.Type;

const RuntimeItemStatus = Schema.Literals(["inProgress", "completed", "failed", "declined"]);
export type RuntimeItemStatus = typeof RuntimeItemStatus.Type;

const RuntimeContentStreamKind = Schema.Literals([
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "plan_text",
  "command_output",
  "file_change_output",
  "unknown",
]);
export type RuntimeContentStreamKind = typeof RuntimeContentStreamKind.Type;

const RuntimeSessionExitKind = Schema.Literals(["graceful", "error"]);
export type RuntimeSessionExitKind = typeof RuntimeSessionExitKind.Type;

const RuntimeErrorClass = Schema.Literals([
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);
export type RuntimeErrorClass = typeof RuntimeErrorClass.Type;

export const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;

export const ToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);
export type ToolLifecycleItemType = typeof ToolLifecycleItemType.Type;

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.includes(value as ToolLifecycleItemType);
}

export const CanonicalItemType = Schema.Literals([
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  ...TOOL_LIFECYCLE_ITEM_TYPES,
  "review_entered",
  "review_exited",
  "context_compaction",
  "error",
  "unknown",
]);
export type CanonicalItemType = typeof CanonicalItemType.Type;

export const CanonicalRequestType = Schema.Literals([
  "command_execution_approval",
  "file_read_approval",
  "file_change_approval",
  "apply_patch_approval",
  "exec_command_approval",
  "tool_user_input",
  "dynamic_tool_call",
  "auth_tokens_refresh",
  "unknown",
]);
export type CanonicalRequestType = typeof CanonicalRequestType.Type;

const ProviderRuntimeEventType = Schema.Literals([
  "session.started",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "thread.metadata.updated",
  "thread.token-usage.updated",
  "turn.started",
  "turn.completed",
  "turn.plan.updated",
  "turn.proposed.delta",
  "turn.proposed.completed",
  "turn.diff.updated",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.progress",
  "task.completed",
  "runtime.warning",
  "runtime.error",
]);
export type ProviderRuntimeEventType = typeof ProviderRuntimeEventType.Type;

const SessionStartedType = Schema.Literal("session.started");
const SessionStateChangedType = Schema.Literal("session.state.changed");
const SessionExitedType = Schema.Literal("session.exited");
const ThreadStartedType = Schema.Literal("thread.started");
const ThreadStateChangedType = Schema.Literal("thread.state.changed");
const ThreadMetadataUpdatedType = Schema.Literal("thread.metadata.updated");
const ThreadTokenUsageUpdatedType = Schema.Literal("thread.token-usage.updated");
const TurnStartedType = Schema.Literal("turn.started");
const TurnCompletedType = Schema.Literal("turn.completed");
const TurnPlanUpdatedType = Schema.Literal("turn.plan.updated");
const TurnProposedDeltaType = Schema.Literal("turn.proposed.delta");
const TurnProposedCompletedType = Schema.Literal("turn.proposed.completed");
const TurnDiffUpdatedType = Schema.Literal("turn.diff.updated");
const ItemStartedType = Schema.Literal("item.started");
const ItemUpdatedType = Schema.Literal("item.updated");
const ItemCompletedType = Schema.Literal("item.completed");
const ContentDeltaType = Schema.Literal("content.delta");
const RequestOpenedType = Schema.Literal("request.opened");
const RequestResolvedType = Schema.Literal("request.resolved");
const UserInputRequestedType = Schema.Literal("user-input.requested");
const UserInputResolvedType = Schema.Literal("user-input.resolved");
const TaskStartedType = Schema.Literal("task.started");
const TaskProgressType = Schema.Literal("task.progress");
const TaskCompletedType = Schema.Literal("task.completed");
const RuntimeWarningType = Schema.Literal("runtime.warning");
const RuntimeErrorType = Schema.Literal("runtime.error");

const ProviderRuntimeEventBase = Schema.Struct({
  eventId: EventId,
  provider: ProviderKind,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(RuntimeItemId),
  requestId: Schema.optional(RuntimeRequestId),
  providerRefs: Schema.optional(ProviderRefs),
  raw: Schema.optional(RuntimeEventRaw),
});
export type ProviderRuntimeEventBase = typeof ProviderRuntimeEventBase.Type;

const SessionStartedPayload = Schema.Struct({
  message: Schema.optional(TrimmedNonEmptyStringSchema),
  resume: Schema.optional(Schema.Unknown),
});
export type SessionStartedPayload = typeof SessionStartedPayload.Type;

const SessionStateChangedPayload = Schema.Struct({
  state: RuntimeSessionState,
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
  detail: Schema.optional(Schema.Unknown),
});
export type SessionStateChangedPayload = typeof SessionStateChangedPayload.Type;

const SessionExitedPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
  recoverable: Schema.optional(Schema.Boolean),
  exitKind: Schema.optional(RuntimeSessionExitKind),
});
export type SessionExitedPayload = typeof SessionExitedPayload.Type;

const ThreadStartedPayload = Schema.Struct({
  providerThreadId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ThreadStartedPayload = typeof ThreadStartedPayload.Type;

const ThreadStateChangedPayload = Schema.Struct({
  state: RuntimeThreadState,
  detail: Schema.optional(Schema.Unknown),
});
export type ThreadStateChangedPayload = typeof ThreadStateChangedPayload.Type;

const ThreadMetadataUpdatedPayload = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyStringSchema),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ThreadMetadataUpdatedPayload = typeof ThreadMetadataUpdatedPayload.Type;

const ThreadTokenUsageUpdatedPayload = Schema.Struct({
  usage: ThreadTokenUsageSnapshot,
});
export type ThreadTokenUsageUpdatedPayload = typeof ThreadTokenUsageUpdatedPayload.Type;

const TurnStartedPayload = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TurnStartedPayload = typeof TurnStartedPayload.Type;

const TurnCompletedPayload = Schema.Struct({
  state: RuntimeTurnState,
  stopReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  usage: Schema.optional(ThreadTokenUsageSnapshot),
  totalCostUsd: Schema.optional(Schema.Number),
  errorMessage: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TurnCompletedPayload = typeof TurnCompletedPayload.Type;

const RuntimePlanStep = Schema.Struct({
  step: TrimmedNonEmptyStringSchema,
  status: RuntimePlanStepStatus,
});
export type RuntimePlanStep = typeof RuntimePlanStep.Type;

const TurnPlanUpdatedPayload = Schema.Struct({
  explanation: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  plan: Schema.Array(RuntimePlanStep),
});
export type TurnPlanUpdatedPayload = typeof TurnPlanUpdatedPayload.Type;

const TurnProposedDeltaPayload = Schema.Struct({
  delta: Schema.String,
});
export type TurnProposedDeltaPayload = typeof TurnProposedDeltaPayload.Type;

const TurnProposedCompletedPayload = Schema.Struct({
  planMarkdown: TrimmedNonEmptyStringSchema,
});
export type TurnProposedCompletedPayload = typeof TurnProposedCompletedPayload.Type;

const TurnDiffUpdatedPayload = Schema.Struct({
  unifiedDiff: Schema.String,
});
export type TurnDiffUpdatedPayload = typeof TurnDiffUpdatedPayload.Type;

export const ItemLifecyclePayload = Schema.Struct({
  itemType: CanonicalItemType,
  status: Schema.optional(RuntimeItemStatus),
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  data: Schema.optional(CanonicalToolLifecycleData),
});
export type ItemLifecyclePayload = typeof ItemLifecyclePayload.Type;

const ContentDeltaPayload = Schema.Struct({
  streamKind: RuntimeContentStreamKind,
  delta: Schema.String,
  contentIndex: Schema.optional(Schema.Int),
  summaryIndex: Schema.optional(Schema.Int),
});
export type ContentDeltaPayload = typeof ContentDeltaPayload.Type;

const RequestOpenedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  args: Schema.optional(Schema.Unknown),
});
export type RequestOpenedPayload = typeof RequestOpenedPayload.Type;

const RequestResolvedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  decision: Schema.optional(TrimmedNonEmptyStringSchema),
  resolution: Schema.optional(Schema.Unknown),
});
export type RequestResolvedPayload = typeof RequestResolvedPayload.Type;

const UserInputRequestedPayload = Schema.Struct({
  questions: Schema.Array(UserInputQuestion),
});
export type UserInputRequestedPayload = typeof UserInputRequestedPayload.Type;

const UserInputResolvedPayload = Schema.Struct({
  answers: ProviderUserInputAnswers,
});
export type UserInputResolvedPayload = typeof UserInputResolvedPayload.Type;

const TaskStartedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  taskType: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskStartedPayload = typeof TaskStartedPayload.Type;

const TaskProgressPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: TrimmedNonEmptyStringSchema,
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(ThreadTokenUsageSnapshot),
  lastToolName: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskProgressPayload = typeof TaskProgressPayload.Type;

const TaskCompletedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.Literals(["completed", "failed", "stopped"]),
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(ThreadTokenUsageSnapshot),
});
export type TaskCompletedPayload = typeof TaskCompletedPayload.Type;

const RuntimeWarningPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  detail: Schema.optional(Schema.Unknown),
});
export type RuntimeWarningPayload = typeof RuntimeWarningPayload.Type;

const RuntimeErrorPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  class: Schema.optional(RuntimeErrorClass),
  detail: Schema.optional(Schema.Unknown),
});
export type RuntimeErrorPayload = typeof RuntimeErrorPayload.Type;

const ProviderRuntimeSessionStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionStartedType,
  payload: SessionStartedPayload,
});
export type ProviderRuntimeSessionStartedEvent = typeof ProviderRuntimeSessionStartedEvent.Type;

const ProviderRuntimeSessionStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionStateChangedType,
  payload: SessionStateChangedPayload,
});
export type ProviderRuntimeSessionStateChangedEvent =
  typeof ProviderRuntimeSessionStateChangedEvent.Type;

const ProviderRuntimeSessionExitedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionExitedType,
  payload: SessionExitedPayload,
});
export type ProviderRuntimeSessionExitedEvent = typeof ProviderRuntimeSessionExitedEvent.Type;

const ProviderRuntimeThreadStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadStartedType,
  payload: ThreadStartedPayload,
});
export type ProviderRuntimeThreadStartedEvent = typeof ProviderRuntimeThreadStartedEvent.Type;

const ProviderRuntimeThreadStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadStateChangedType,
  payload: ThreadStateChangedPayload,
});
export type ProviderRuntimeThreadStateChangedEvent =
  typeof ProviderRuntimeThreadStateChangedEvent.Type;

const ProviderRuntimeThreadMetadataUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadMetadataUpdatedType,
  payload: ThreadMetadataUpdatedPayload,
});
export type ProviderRuntimeThreadMetadataUpdatedEvent =
  typeof ProviderRuntimeThreadMetadataUpdatedEvent.Type;

const ProviderRuntimeThreadTokenUsageUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadTokenUsageUpdatedType,
  payload: ThreadTokenUsageUpdatedPayload,
});
export type ProviderRuntimeThreadTokenUsageUpdatedEvent =
  typeof ProviderRuntimeThreadTokenUsageUpdatedEvent.Type;

const ProviderRuntimeTurnStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnStartedType,
  payload: TurnStartedPayload,
});
export type ProviderRuntimeTurnStartedEvent = typeof ProviderRuntimeTurnStartedEvent.Type;

const ProviderRuntimeTurnCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnCompletedType,
  payload: TurnCompletedPayload,
});
export type ProviderRuntimeTurnCompletedEvent = typeof ProviderRuntimeTurnCompletedEvent.Type;

const ProviderRuntimeTurnPlanUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnPlanUpdatedType,
  payload: TurnPlanUpdatedPayload,
});
export type ProviderRuntimeTurnPlanUpdatedEvent = typeof ProviderRuntimeTurnPlanUpdatedEvent.Type;

const ProviderRuntimeTurnProposedDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnProposedDeltaType,
  payload: TurnProposedDeltaPayload,
});
export type ProviderRuntimeTurnProposedDeltaEvent =
  typeof ProviderRuntimeTurnProposedDeltaEvent.Type;

const ProviderRuntimeTurnProposedCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnProposedCompletedType,
  payload: TurnProposedCompletedPayload,
});
export type ProviderRuntimeTurnProposedCompletedEvent =
  typeof ProviderRuntimeTurnProposedCompletedEvent.Type;

const ProviderRuntimeTurnDiffUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnDiffUpdatedType,
  payload: TurnDiffUpdatedPayload,
});
export type ProviderRuntimeTurnDiffUpdatedEvent = typeof ProviderRuntimeTurnDiffUpdatedEvent.Type;

const ProviderRuntimeItemStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemStartedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemStartedEvent = typeof ProviderRuntimeItemStartedEvent.Type;

const ProviderRuntimeItemUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemUpdatedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemUpdatedEvent = typeof ProviderRuntimeItemUpdatedEvent.Type;

const ProviderRuntimeItemCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemCompletedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemCompletedEvent = typeof ProviderRuntimeItemCompletedEvent.Type;

const ProviderRuntimeContentDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ContentDeltaType,
  payload: ContentDeltaPayload,
});
export type ProviderRuntimeContentDeltaEvent = typeof ProviderRuntimeContentDeltaEvent.Type;

const ProviderRuntimeRequestOpenedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestOpenedType,
  payload: RequestOpenedPayload,
});
export type ProviderRuntimeRequestOpenedEvent = typeof ProviderRuntimeRequestOpenedEvent.Type;

const ProviderRuntimeRequestResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestResolvedType,
  payload: RequestResolvedPayload,
});
export type ProviderRuntimeRequestResolvedEvent = typeof ProviderRuntimeRequestResolvedEvent.Type;

const ProviderRuntimeUserInputRequestedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputRequestedType,
  payload: UserInputRequestedPayload,
});
export type ProviderRuntimeUserInputRequestedEvent =
  typeof ProviderRuntimeUserInputRequestedEvent.Type;

const ProviderRuntimeUserInputResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputResolvedType,
  payload: UserInputResolvedPayload,
});
export type ProviderRuntimeUserInputResolvedEvent =
  typeof ProviderRuntimeUserInputResolvedEvent.Type;

const ProviderRuntimeTaskStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskStartedType,
  payload: TaskStartedPayload,
});
export type ProviderRuntimeTaskStartedEvent = typeof ProviderRuntimeTaskStartedEvent.Type;

const ProviderRuntimeTaskProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskProgressType,
  payload: TaskProgressPayload,
});
export type ProviderRuntimeTaskProgressEvent = typeof ProviderRuntimeTaskProgressEvent.Type;

const ProviderRuntimeTaskCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskCompletedType,
  payload: TaskCompletedPayload,
});
export type ProviderRuntimeTaskCompletedEvent = typeof ProviderRuntimeTaskCompletedEvent.Type;

const ProviderRuntimeWarningEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeWarningType,
  payload: RuntimeWarningPayload,
});
export type ProviderRuntimeWarningEvent = typeof ProviderRuntimeWarningEvent.Type;

const ProviderRuntimeErrorEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeErrorType,
  payload: RuntimeErrorPayload,
});
export type ProviderRuntimeErrorEvent = typeof ProviderRuntimeErrorEvent.Type;

export const ProviderRuntimeEventV2 = Schema.Union([
  ProviderRuntimeSessionStartedEvent,
  ProviderRuntimeSessionStateChangedEvent,
  ProviderRuntimeSessionExitedEvent,
  ProviderRuntimeThreadStartedEvent,
  ProviderRuntimeThreadStateChangedEvent,
  ProviderRuntimeThreadMetadataUpdatedEvent,
  ProviderRuntimeThreadTokenUsageUpdatedEvent,
  ProviderRuntimeTurnStartedEvent,
  ProviderRuntimeTurnCompletedEvent,
  ProviderRuntimeTurnPlanUpdatedEvent,
  ProviderRuntimeTurnProposedDeltaEvent,
  ProviderRuntimeTurnProposedCompletedEvent,
  ProviderRuntimeTurnDiffUpdatedEvent,
  ProviderRuntimeItemStartedEvent,
  ProviderRuntimeItemUpdatedEvent,
  ProviderRuntimeItemCompletedEvent,
  ProviderRuntimeContentDeltaEvent,
  ProviderRuntimeRequestOpenedEvent,
  ProviderRuntimeRequestResolvedEvent,
  ProviderRuntimeUserInputRequestedEvent,
  ProviderRuntimeUserInputResolvedEvent,
  ProviderRuntimeTaskStartedEvent,
  ProviderRuntimeTaskProgressEvent,
  ProviderRuntimeTaskCompletedEvent,
  ProviderRuntimeWarningEvent,
  ProviderRuntimeErrorEvent,
]);
export type ProviderRuntimeEventV2 = typeof ProviderRuntimeEventV2.Type;

export const ProviderRuntimeEvent = ProviderRuntimeEventV2;
export type ProviderRuntimeEvent = ProviderRuntimeEventV2;

// Compatibility aliases for call sites still importing legacy names.
const ProviderRuntimeMessageDeltaEvent = ProviderRuntimeContentDeltaEvent;
export type ProviderRuntimeMessageDeltaEvent = ProviderRuntimeContentDeltaEvent;
const ProviderRuntimeMessageCompletedEvent = ProviderRuntimeItemCompletedEvent;
export type ProviderRuntimeMessageCompletedEvent = ProviderRuntimeItemCompletedEvent;
const ProviderRuntimeToolStartedEvent = ProviderRuntimeItemStartedEvent;
export type ProviderRuntimeToolStartedEvent = ProviderRuntimeItemStartedEvent;
const ProviderRuntimeToolCompletedEvent = ProviderRuntimeItemCompletedEvent;
export type ProviderRuntimeToolCompletedEvent = ProviderRuntimeItemCompletedEvent;
const ProviderRuntimeApprovalRequestedEvent = ProviderRuntimeRequestOpenedEvent;
export type ProviderRuntimeApprovalRequestedEvent = ProviderRuntimeRequestOpenedEvent;
const ProviderRuntimeApprovalResolvedEvent = ProviderRuntimeRequestResolvedEvent;
export type ProviderRuntimeApprovalResolvedEvent = ProviderRuntimeRequestResolvedEvent;

// Legacy helper aliases retained for adapters/tests.
const ProviderRuntimeToolKind = Schema.Literals(["command", "file-read", "file-change", "other"]);
export type ProviderRuntimeToolKind = typeof ProviderRuntimeToolKind.Type;

export const ProviderRuntimeTurnStatus = RuntimeTurnState;
export type ProviderRuntimeTurnStatus = RuntimeTurnState;
