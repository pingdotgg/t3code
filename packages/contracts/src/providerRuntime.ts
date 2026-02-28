import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

import {
  ApprovalRequestId,
  EventId,
  NonNegativeInt,
  ProviderItemId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  IsoDateTime,
} from "./baseSchemas";
import { ProviderApprovalDecision, ProviderKind, ProviderRequestKind } from "./orchestration";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

export const ProviderRuntimeToolKind = Schema.Union([ProviderRequestKind, Schema.Literal("other")]);
export type ProviderRuntimeToolKind = typeof ProviderRuntimeToolKind.Type;

export const ProviderRuntimeTurnStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type ProviderRuntimeTurnStatus = typeof ProviderRuntimeTurnStatus.Type;

export const ProviderRuntimeSessionStartedEvent = Schema.Struct({
  type: Schema.Literal("session.started"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: Schema.optional(ProviderThreadId),
  message: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ProviderRuntimeSessionStartedEvent = typeof ProviderRuntimeSessionStartedEvent.Type;

export const ProviderRuntimeSessionExitedEvent = Schema.Struct({
  type: Schema.Literal("session.exited"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: Schema.optional(ProviderThreadId),
  message: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ProviderRuntimeSessionExitedEvent = typeof ProviderRuntimeSessionExitedEvent.Type;

export const ProviderRuntimeThreadStartedEvent = Schema.Struct({
  type: Schema.Literal("thread.started"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: ProviderThreadId,
});
export type ProviderRuntimeThreadStartedEvent = typeof ProviderRuntimeThreadStartedEvent.Type;

export const ProviderRuntimeTurnStartedEvent = Schema.Struct({
  type: Schema.Literal("turn.started"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: Schema.optional(ProviderThreadId),
  turnId: ProviderTurnId,
});
export type ProviderRuntimeTurnStartedEvent = typeof ProviderRuntimeTurnStartedEvent.Type;

export const ProviderRuntimeTurnCompletedEvent = Schema.Struct({
  type: Schema.Literal("turn.completed"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: Schema.optional(ProviderThreadId),
  turnId: Schema.optional(ProviderTurnId),
  status: Schema.optional(ProviderRuntimeTurnStatus),
  errorMessage: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ProviderRuntimeTurnCompletedEvent = typeof ProviderRuntimeTurnCompletedEvent.Type;

export const ProviderRuntimeMessageDeltaEvent = Schema.Struct({
  type: Schema.Literal("message.delta"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: Schema.optional(ProviderThreadId),
  turnId: Schema.optional(ProviderTurnId),
  itemId: Schema.optional(ProviderItemId),
  delta: Schema.String,
});
export type ProviderRuntimeMessageDeltaEvent = typeof ProviderRuntimeMessageDeltaEvent.Type;

export const ProviderRuntimeMessageCompletedEvent = Schema.Struct({
  type: Schema.Literal("message.completed"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  itemId: ProviderItemId,
  threadId: Schema.optional(ProviderThreadId),
  turnId: Schema.optional(ProviderTurnId),
});
export type ProviderRuntimeMessageCompletedEvent = typeof ProviderRuntimeMessageCompletedEvent.Type;

export const ProviderRuntimeToolStartedEvent = Schema.Struct({
  type: Schema.Literal("tool.started"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: Schema.optional(ProviderThreadId),
  turnId: Schema.optional(ProviderTurnId),
  itemId: Schema.optional(ProviderItemId),
  toolKind: ProviderRuntimeToolKind,
  title: TrimmedNonEmptyStringSchema,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ProviderRuntimeToolStartedEvent = typeof ProviderRuntimeToolStartedEvent.Type;

export const ProviderRuntimeToolCompletedEvent = Schema.Struct({
  type: Schema.Literal("tool.completed"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: Schema.optional(ProviderThreadId),
  turnId: Schema.optional(ProviderTurnId),
  itemId: Schema.optional(ProviderItemId),
  toolKind: ProviderRuntimeToolKind,
  title: TrimmedNonEmptyStringSchema,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ProviderRuntimeToolCompletedEvent = typeof ProviderRuntimeToolCompletedEvent.Type;

export const ProviderRuntimeApprovalRequestedEvent = Schema.Struct({
  type: Schema.Literal("approval.requested"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: Schema.optional(ProviderThreadId),
  turnId: Schema.optional(ProviderTurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: ApprovalRequestId,
  requestKind: ProviderRequestKind,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ProviderRuntimeApprovalRequestedEvent =
  typeof ProviderRuntimeApprovalRequestedEvent.Type;

export const ProviderRuntimeApprovalResolvedEvent = Schema.Struct({
  type: Schema.Literal("approval.resolved"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: Schema.optional(ProviderThreadId),
  turnId: Schema.optional(ProviderTurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: ApprovalRequestId,
  requestKind: Schema.optional(ProviderRequestKind),
  decision: Schema.optional(ProviderApprovalDecision),
});
export type ProviderRuntimeApprovalResolvedEvent = typeof ProviderRuntimeApprovalResolvedEvent.Type;

export const ProviderRuntimeCheckpointCapturedEvent = Schema.Struct({
  type: Schema.Literal("checkpoint.captured"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: ProviderThreadId,
  turnId: Schema.optional(ProviderTurnId),
  turnCount: NonNegativeInt,
  status: Schema.optional(ProviderRuntimeTurnStatus),
});
export type ProviderRuntimeCheckpointCapturedEvent =
  typeof ProviderRuntimeCheckpointCapturedEvent.Type;

export const ProviderRuntimeErrorEvent = Schema.Struct({
  type: Schema.Literal("runtime.error"),
  eventId: EventId,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  sessionSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  threadId: Schema.optional(ProviderThreadId),
  turnId: Schema.optional(ProviderTurnId),
  itemId: Schema.optional(ProviderItemId),
  message: TrimmedNonEmptyStringSchema,
});
export type ProviderRuntimeErrorEvent = typeof ProviderRuntimeErrorEvent.Type;

export const ProviderRuntimeEvent = Schema.Union([
  ProviderRuntimeSessionStartedEvent,
  ProviderRuntimeSessionExitedEvent,
  ProviderRuntimeThreadStartedEvent,
  ProviderRuntimeTurnStartedEvent,
  ProviderRuntimeTurnCompletedEvent,
  ProviderRuntimeMessageDeltaEvent,
  ProviderRuntimeMessageCompletedEvent,
  ProviderRuntimeToolStartedEvent,
  ProviderRuntimeToolCompletedEvent,
  ProviderRuntimeApprovalRequestedEvent,
  ProviderRuntimeApprovalResolvedEvent,
  ProviderRuntimeCheckpointCapturedEvent,
  ProviderRuntimeErrorEvent,
]);
export type ProviderRuntimeEvent = typeof ProviderRuntimeEvent.Type;
