import { Schema } from "effect";

import {
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const DelegationAuditEvidenceStatus = Schema.Literals([
  "complete",
  "redacted",
  "truncated",
  "unavailable",
  "expired",
]);
export type DelegationAuditEvidenceStatus = typeof DelegationAuditEvidenceStatus.Type;

export const DelegationAuditEventType = Schema.Literals([
  "operation.requested",
  "operation.completed",
  "operation.failed",
  "attempt.requested",
  "workspace.create.requested",
  "workspace.created",
  "workspace.create.failed",
  "thread.create.requested",
  "thread.created",
  "thread.create.failed",
  "turn.start.requested",
  "turn.start.accepted",
  "turn.start.rejected",
  "thread.delete.requested",
  "thread.deletion.accepted",
  "thread.deletion.failed",
  "cleanup.requested",
  "cleanup.queued",
  "cleanup.started",
  "cleanup.completed",
  "cleanup.failed",
  "cleanup.cancelled",
  "attempt.completed",
]);
export type DelegationAuditEventType = typeof DelegationAuditEventType.Type;

export const DelegationAuditAuthorizationContext = Schema.Struct({
  sourceThreadId: ThreadId,
  sourceTurnId: Schema.NullOr(TurnId),
  initiatingMessageId: Schema.NullOr(MessageId),
  scope: Schema.Literal("orchestration:operate"),
});
export type DelegationAuditAuthorizationContext = typeof DelegationAuditAuthorizationContext.Type;

export const DelegationAuditEventContext = Schema.Struct({
  authorization: DelegationAuditAuthorizationContext,
  toolName: Schema.String,
  toolVersion: Schema.String,
  toolCallId: Schema.String,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(Schema.String),
  workspaceRoot: Schema.NullOr(Schema.String),
  gitRevision: Schema.NullOr(Schema.String),
  buildRevision: Schema.String,
});
export type DelegationAuditEventContext = typeof DelegationAuditEventContext.Type;

export const DelegationAuditEvent = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  operationId: Schema.String,
  attemptId: Schema.NullOr(Schema.String),
  sourceThreadId: ThreadId,
  sourceTurnId: Schema.NullOr(TurnId),
  sourceMessageId: Schema.NullOr(MessageId),
  childThreadId: Schema.NullOr(ThreadId),
  eventType: DelegationAuditEventType,
  occurredAt: IsoDateTime,
  evidenceStatus: DelegationAuditEvidenceStatus,
  redacted: Schema.Boolean,
  context: DelegationAuditEventContext,
  payload: Schema.Unknown,
});
export type DelegationAuditEvent = typeof DelegationAuditEvent.Type;

export const DelegationAuditBeginInput = Schema.Struct({
  operationId: Schema.String,
  sourceThreadId: ThreadId,
  toolCallId: Schema.String,
  toolName: Schema.String,
  toolVersion: Schema.String,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(Schema.String),
  workspaceRoot: Schema.NullOr(Schema.String),
  gitRevision: Schema.NullOr(Schema.String),
  buildRevision: Schema.String,
  requests: Schema.Array(
    Schema.Struct({
      attemptId: Schema.String,
      arguments: Schema.Unknown,
    }),
  ).check(Schema.isMaxLength(64)),
  occurredAt: IsoDateTime,
});
export type DelegationAuditBeginInput = typeof DelegationAuditBeginInput.Type;

export const DelegationAuditAppendInput = Schema.Struct({
  eventId: EventId,
  operationId: Schema.String,
  sourceThreadId: ThreadId,
  attemptId: Schema.NullOr(Schema.String),
  eventType: DelegationAuditEventType,
  childThreadId: Schema.NullOr(ThreadId),
  payload: Schema.Unknown,
  occurredAt: IsoDateTime,
});
export type DelegationAuditAppendInput = typeof DelegationAuditAppendInput.Type;

export const DelegationAuditBeginResult = Schema.Struct({
  operationId: Schema.String,
  sourceThreadId: ThreadId,
  sourceTurnId: Schema.NullOr(TurnId),
  sourceMessageId: Schema.NullOr(MessageId),
  initiatingMessageId: Schema.NullOr(MessageId),
});
export type DelegationAuditBeginResult = typeof DelegationAuditBeginResult.Type;

export class DelegationAuditError extends Schema.TaggedErrorClass<DelegationAuditError>()(
  "DelegationAuditError",
  {
    code: Schema.Literals([
      "source-thread-not-found",
      "operation-not-found",
      "activity-not-found",
      "invalid-audit-request",
      "audit-persistence-unavailable",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const DelegationAuditPageInput = Schema.Struct({
  sourceThreadId: Schema.optional(ThreadId),
  operationId: Schema.optional(Schema.String),
  turnId: Schema.optional(TurnId),
  beforeSequence: Schema.NullOr(NonNegativeInt),
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100)),
});
export type DelegationAuditPageInput = typeof DelegationAuditPageInput.Type;

export const DelegationAuditPage = Schema.Struct({
  sourceThreadId: ThreadId,
  events: Schema.Array(DelegationAuditEvent),
  cleanupStates: Schema.Array(
    Schema.Struct({
      attemptId: Schema.String,
      childThreadId: ThreadId,
      jobId: Schema.NullOr(Schema.String),
      status: Schema.Literals([
        "pending-enqueue",
        "waiting",
        "removing",
        "needs-attention",
        "completed",
        "cancelled",
        "not-required",
      ]),
      attemptCount: Schema.NullOr(NonNegativeInt),
      nextAttemptAt: Schema.NullOr(IsoDateTime),
      reason: Schema.NullOr(Schema.String),
      error: Schema.NullOr(Schema.String),
    }),
  ),
  nextBeforeSequence: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
});
export type DelegationAuditPage = typeof DelegationAuditPage.Type;

export const DelegationAuditActivityEvidenceInput = Schema.Struct({
  threadId: ThreadId,
  activityId: EventId,
});
export type DelegationAuditActivityEvidenceInput = typeof DelegationAuditActivityEvidenceInput.Type;

export const DelegationAuditActivityEvidence = Schema.Struct({
  threadId: ThreadId,
  activityId: EventId,
  evidenceStatus: DelegationAuditEvidenceStatus,
  redacted: Schema.Boolean,
  payload: Schema.Unknown,
  warning: Schema.NullOr(Schema.String),
});
export type DelegationAuditActivityEvidence = typeof DelegationAuditActivityEvidence.Type;

export const DelegationAuditCommandContext = Schema.Struct({
  operationId: Schema.String,
  attemptId: Schema.String,
  initiatingMessageId: Schema.NullOr(MessageId),
});
export type DelegationAuditCommandContext = typeof DelegationAuditCommandContext.Type;
