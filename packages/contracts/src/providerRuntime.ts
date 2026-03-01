import { Schema } from "effect";
import {
  EventId,
  IsoDateTime,
  ProviderItemId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ProviderKind } from "./orchestration";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

export const RuntimeEventRawSource = Schema.Literals([
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

export const ProviderRequestId = TrimmedNonEmptyStringSchema;
export type ProviderRequestId = typeof ProviderRequestId.Type;

export const ProviderRefs = Schema.Struct({
  providerSessionId: Schema.optional(ProviderSessionId),
  providerThreadId: Schema.optional(ProviderThreadId),
  providerTurnId: Schema.optional(ProviderTurnId),
  providerItemId: Schema.optional(ProviderItemId),
  providerRequestId: Schema.optional(ProviderRequestId),
});
export type ProviderRefs = typeof ProviderRefs.Type;

export const RuntimeTurnState = Schema.Literals([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
export type RuntimeTurnState = typeof RuntimeTurnState.Type;

export const RuntimePlanStepStatus = Schema.Literals(["pending", "inProgress", "completed"]);
export type RuntimePlanStepStatus = typeof RuntimePlanStepStatus.Type;

export const RuntimeItemStatus = Schema.Literals(["inProgress", "completed", "failed", "declined"]);
export type RuntimeItemStatus = typeof RuntimeItemStatus.Type;

export const RuntimeContentStreamKind = Schema.Literals([
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "plan_text",
  "command_output",
  "file_change_output",
  "unknown",
]);
export type RuntimeContentStreamKind = typeof RuntimeContentStreamKind.Type;

export const RuntimeSessionExitKind = Schema.Literals(["graceful", "error"]);
export type RuntimeSessionExitKind = typeof RuntimeSessionExitKind.Type;

export const RuntimeErrorClass = Schema.Literals([
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);
export type RuntimeErrorClass = typeof RuntimeErrorClass.Type;

export const CanonicalItemType = Schema.Literals([
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "error",
  "unknown",
]);
export type CanonicalItemType = typeof CanonicalItemType.Type;

export const CanonicalRequestType = Schema.Literals([
  "command_execution_approval",
  "file_change_approval",
  "apply_patch_approval",
  "exec_command_approval",
  "tool_user_input",
  "dynamic_tool_call",
  "unknown",
]);
export type CanonicalRequestType = typeof CanonicalRequestType.Type;

export const ProviderRuntimeEventType = Schema.Literals([
  "session.started",
  "session.exited",
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.plan.updated",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "runtime.warning",
  "runtime.error",
]);
export type ProviderRuntimeEventType = typeof ProviderRuntimeEventType.Type;

export const SessionStartedType = Schema.Literal("session.started");
export const SessionExitedType = Schema.Literal("session.exited");
export const ThreadStartedType = Schema.Literal("thread.started");
export const TurnStartedType = Schema.Literal("turn.started");
export const TurnCompletedType = Schema.Literal("turn.completed");
export const TurnPlanUpdatedType = Schema.Literal("turn.plan.updated");
export const ItemStartedType = Schema.Literal("item.started");
export const ItemUpdatedType = Schema.Literal("item.updated");
export const ItemCompletedType = Schema.Literal("item.completed");
export const ContentDeltaType = Schema.Literal("content.delta");
export const RequestOpenedType = Schema.Literal("request.opened");
export const RequestResolvedType = Schema.Literal("request.resolved");
export const UserInputRequestedType = Schema.Literal("user-input.requested");
export const UserInputResolvedType = Schema.Literal("user-input.resolved");
export const RuntimeWarningType = Schema.Literal("runtime.warning");
export const RuntimeErrorType = Schema.Literal("runtime.error");

export const ProviderRuntimeEventBase = Schema.Struct({
  eventId: EventId,
  provider: ProviderKind,
  sessionId: RuntimeSessionId,
  createdAt: IsoDateTime,
  threadId: Schema.optional(ThreadId),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(RuntimeItemId),
  requestId: Schema.optional(RuntimeRequestId),
  providerRefs: Schema.optional(ProviderRefs),
  raw: Schema.optional(RuntimeEventRaw),
});
export type ProviderRuntimeEventBase = typeof ProviderRuntimeEventBase.Type;

export const SessionStartedPayload = Schema.Struct({
  message: Schema.optional(TrimmedNonEmptyStringSchema),
  resume: Schema.optional(Schema.Unknown),
});
export type SessionStartedPayload = typeof SessionStartedPayload.Type;

export const SessionExitedPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
  recoverable: Schema.optional(Schema.Boolean),
  exitKind: Schema.optional(RuntimeSessionExitKind),
});
export type SessionExitedPayload = typeof SessionExitedPayload.Type;

export const ThreadStartedPayload = Schema.Struct({
  providerThreadId: Schema.optional(ProviderThreadId),
});
export type ThreadStartedPayload = typeof ThreadStartedPayload.Type;

export const TurnStartedPayload = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TurnStartedPayload = typeof TurnStartedPayload.Type;

export const TurnCompletedPayload = Schema.Struct({
  state: RuntimeTurnState,
  stopReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  usage: Schema.optional(Schema.Unknown),
  modelUsage: Schema.optional(UnknownRecordSchema),
  totalCostUsd: Schema.optional(Schema.Number),
  errorMessage: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TurnCompletedPayload = typeof TurnCompletedPayload.Type;

export const RuntimePlanStep = Schema.Struct({
  step: TrimmedNonEmptyStringSchema,
  status: RuntimePlanStepStatus,
});
export type RuntimePlanStep = typeof RuntimePlanStep.Type;

export const TurnPlanUpdatedPayload = Schema.Struct({
  explanation: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  plan: Schema.Array(RuntimePlanStep),
});
export type TurnPlanUpdatedPayload = typeof TurnPlanUpdatedPayload.Type;

export const ItemLifecyclePayload = Schema.Struct({
  itemType: CanonicalItemType,
  status: Schema.optional(RuntimeItemStatus),
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  data: Schema.optional(Schema.Unknown),
});
export type ItemLifecyclePayload = typeof ItemLifecyclePayload.Type;

export const ContentDeltaPayload = Schema.Struct({
  streamKind: RuntimeContentStreamKind,
  delta: Schema.String,
  contentIndex: Schema.optional(Schema.Int),
  summaryIndex: Schema.optional(Schema.Int),
});
export type ContentDeltaPayload = typeof ContentDeltaPayload.Type;

export const RequestOpenedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  args: Schema.optional(Schema.Unknown),
});
export type RequestOpenedPayload = typeof RequestOpenedPayload.Type;

export const RequestResolvedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  decision: Schema.optional(TrimmedNonEmptyStringSchema),
  resolution: Schema.optional(Schema.Unknown),
});
export type RequestResolvedPayload = typeof RequestResolvedPayload.Type;

export const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  description: TrimmedNonEmptyStringSchema,
});
export type UserInputQuestionOption = typeof UserInputQuestionOption.Type;

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  options: Schema.Array(UserInputQuestionOption),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

export const UserInputRequestedPayload = Schema.Struct({
  questions: Schema.Array(UserInputQuestion),
});
export type UserInputRequestedPayload = typeof UserInputRequestedPayload.Type;

export const UserInputResolvedPayload = Schema.Struct({
  answers: UnknownRecordSchema,
});
export type UserInputResolvedPayload = typeof UserInputResolvedPayload.Type;

export const RuntimeWarningPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  detail: Schema.optional(Schema.Unknown),
});
export type RuntimeWarningPayload = typeof RuntimeWarningPayload.Type;

export const RuntimeErrorPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  class: Schema.optional(RuntimeErrorClass),
  detail: Schema.optional(Schema.Unknown),
});
export type RuntimeErrorPayload = typeof RuntimeErrorPayload.Type;

export const ProviderRuntimeSessionStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionStartedType,
  payload: SessionStartedPayload,
});
export type ProviderRuntimeSessionStartedEvent = typeof ProviderRuntimeSessionStartedEvent.Type;

export const ProviderRuntimeSessionExitedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionExitedType,
  payload: SessionExitedPayload,
});
export type ProviderRuntimeSessionExitedEvent = typeof ProviderRuntimeSessionExitedEvent.Type;

export const ProviderRuntimeThreadStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadStartedType,
  payload: ThreadStartedPayload,
});
export type ProviderRuntimeThreadStartedEvent = typeof ProviderRuntimeThreadStartedEvent.Type;

export const ProviderRuntimeTurnStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnStartedType,
  payload: TurnStartedPayload,
});
export type ProviderRuntimeTurnStartedEvent = typeof ProviderRuntimeTurnStartedEvent.Type;

export const ProviderRuntimeTurnCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnCompletedType,
  payload: TurnCompletedPayload,
});
export type ProviderRuntimeTurnCompletedEvent = typeof ProviderRuntimeTurnCompletedEvent.Type;

export const ProviderRuntimeTurnPlanUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnPlanUpdatedType,
  payload: TurnPlanUpdatedPayload,
});
export type ProviderRuntimeTurnPlanUpdatedEvent = typeof ProviderRuntimeTurnPlanUpdatedEvent.Type;

export const ProviderRuntimeItemStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemStartedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemStartedEvent = typeof ProviderRuntimeItemStartedEvent.Type;

export const ProviderRuntimeItemUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemUpdatedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemUpdatedEvent = typeof ProviderRuntimeItemUpdatedEvent.Type;

export const ProviderRuntimeItemCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemCompletedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemCompletedEvent = typeof ProviderRuntimeItemCompletedEvent.Type;

export const ProviderRuntimeContentDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ContentDeltaType,
  payload: ContentDeltaPayload,
});
export type ProviderRuntimeContentDeltaEvent = typeof ProviderRuntimeContentDeltaEvent.Type;

export const ProviderRuntimeRequestOpenedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestOpenedType,
  payload: RequestOpenedPayload,
});
export type ProviderRuntimeRequestOpenedEvent = typeof ProviderRuntimeRequestOpenedEvent.Type;

export const ProviderRuntimeRequestResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestResolvedType,
  payload: RequestResolvedPayload,
});
export type ProviderRuntimeRequestResolvedEvent = typeof ProviderRuntimeRequestResolvedEvent.Type;

export const ProviderRuntimeUserInputRequestedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputRequestedType,
  payload: UserInputRequestedPayload,
});
export type ProviderRuntimeUserInputRequestedEvent =
  typeof ProviderRuntimeUserInputRequestedEvent.Type;

export const ProviderRuntimeUserInputResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputResolvedType,
  payload: UserInputResolvedPayload,
});
export type ProviderRuntimeUserInputResolvedEvent =
  typeof ProviderRuntimeUserInputResolvedEvent.Type;

export const ProviderRuntimeWarningEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeWarningType,
  payload: RuntimeWarningPayload,
});
export type ProviderRuntimeWarningEvent = typeof ProviderRuntimeWarningEvent.Type;

export const ProviderRuntimeErrorEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeErrorType,
  payload: RuntimeErrorPayload,
});
export type ProviderRuntimeErrorEvent = typeof ProviderRuntimeErrorEvent.Type;

export const ProviderRuntimeEventV2 = Schema.Union([
  ProviderRuntimeSessionStartedEvent,
  ProviderRuntimeSessionExitedEvent,
  ProviderRuntimeThreadStartedEvent,
  ProviderRuntimeTurnStartedEvent,
  ProviderRuntimeTurnCompletedEvent,
  ProviderRuntimeTurnPlanUpdatedEvent,
  ProviderRuntimeItemStartedEvent,
  ProviderRuntimeItemUpdatedEvent,
  ProviderRuntimeItemCompletedEvent,
  ProviderRuntimeContentDeltaEvent,
  ProviderRuntimeRequestOpenedEvent,
  ProviderRuntimeRequestResolvedEvent,
  ProviderRuntimeUserInputRequestedEvent,
  ProviderRuntimeUserInputResolvedEvent,
  ProviderRuntimeWarningEvent,
  ProviderRuntimeErrorEvent,
]);
export type ProviderRuntimeEventV2 = typeof ProviderRuntimeEventV2.Type;

export const ProviderRuntimeEvent = ProviderRuntimeEventV2;
export type ProviderRuntimeEvent = ProviderRuntimeEventV2;

export const ProviderRuntimeMessageDeltaEvent = ProviderRuntimeContentDeltaEvent;
export type ProviderRuntimeMessageDeltaEvent = ProviderRuntimeContentDeltaEvent;
export const ProviderRuntimeMessageCompletedEvent = ProviderRuntimeItemCompletedEvent;
export type ProviderRuntimeMessageCompletedEvent = ProviderRuntimeItemCompletedEvent;
export const ProviderRuntimeToolStartedEvent = ProviderRuntimeItemStartedEvent;
export type ProviderRuntimeToolStartedEvent = ProviderRuntimeItemStartedEvent;
export const ProviderRuntimeToolCompletedEvent = ProviderRuntimeItemCompletedEvent;
export type ProviderRuntimeToolCompletedEvent = ProviderRuntimeItemCompletedEvent;
export const ProviderRuntimeApprovalRequestedEvent = ProviderRuntimeRequestOpenedEvent;
export type ProviderRuntimeApprovalRequestedEvent = ProviderRuntimeRequestOpenedEvent;
export const ProviderRuntimeApprovalResolvedEvent = ProviderRuntimeRequestResolvedEvent;
export type ProviderRuntimeApprovalResolvedEvent = ProviderRuntimeRequestResolvedEvent;

export const ProviderRuntimeToolKind = Schema.Literals([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "other",
]);
export type ProviderRuntimeToolKind = typeof ProviderRuntimeToolKind.Type;

export const ProviderRuntimeTurnStatus = RuntimeTurnState;
export type ProviderRuntimeTurnStatus = RuntimeTurnState;
