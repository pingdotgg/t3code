import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

export const HermesProactiveRequiredCapabilities = [
  "cron.events.global_cursor",
  "events.stable_ids",
] as const;

export const HermesProactiveCapabilityState = Schema.Literals(["ready", "degraded"]);
export type HermesProactiveCapabilityState = typeof HermesProactiveCapabilityState.Type;

export const HermesProactiveDiagnosticCode = Schema.Literals([
  "ready",
  "missing_capability_inventory",
  "missing_durable_global_cursor",
  "missing_stable_event_ids",
]);
export type HermesProactiveDiagnosticCode = typeof HermesProactiveDiagnosticCode.Type;

export const HermesProactiveSourceStatus = Schema.Struct({
  sourceId: Schema.String,
  providerInstanceId: Schema.String,
  profileKey: Schema.String,
  state: HermesProactiveCapabilityState,
  diagnosticCode: HermesProactiveDiagnosticCode,
  missingCapabilities: Schema.Array(Schema.String),
  checkpointCursor: Schema.NullOr(Schema.String),
  checkpointSequence: NonNegativeInt,
  lastCheckedAt: Schema.String,
  updatedAt: Schema.String,
});
export type HermesProactiveSourceStatus = typeof HermesProactiveSourceStatus.Type;

export const HermesProactiveEventProvenance = Schema.Struct({
  provider: Schema.Literal("hermes"),
  providerInstanceId: Schema.String,
  profileKey: Schema.String,
  sourceId: Schema.String,
  externalEventId: Schema.String,
  externalCursor: Schema.String,
  gatewayRevision: Schema.NullOr(Schema.String),
  protocolMajor: Schema.NullOr(NonNegativeInt),
  protocolMinor: Schema.NullOr(NonNegativeInt),
  ingestedAt: Schema.String,
});
export type HermesProactiveEventProvenance = typeof HermesProactiveEventProvenance.Type;

export const HermesProactiveEvent = Schema.Struct({
  eventId: Schema.String,
  sourceId: Schema.String,
  externalEventId: Schema.String,
  externalCursor: Schema.String,
  eventKind: Schema.String,
  title: Schema.String,
  body: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  occurredAt: Schema.String,
  receivedAt: Schema.String,
  provenance: HermesProactiveEventProvenance,
});
export type HermesProactiveEvent = typeof HermesProactiveEvent.Type;

export const HermesProactiveWorkItem = Schema.Struct({
  workItemId: Schema.String,
  eventId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  title: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(["unread", "read", "dismissed"]),
  occurredAt: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type HermesProactiveWorkItem = typeof HermesProactiveWorkItem.Type;

export const HermesInAppNotification = Schema.Struct({
  notificationId: Schema.String,
  eventId: Schema.String,
  workItemId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  title: Schema.String,
  body: Schema.String,
  status: Schema.Literals(["unread", "read", "dismissed"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type HermesInAppNotification = typeof HermesInAppNotification.Type;

export const HermesNotificationOutboxState = Schema.Literals([
  "pending",
  "processing",
  "retry",
  "delivered",
  "dead_letter",
]);
export type HermesNotificationOutboxState = typeof HermesNotificationOutboxState.Type;

export const HermesNotificationOutboxEntry = Schema.Struct({
  outboxId: Schema.String,
  eventId: Schema.String,
  state: HermesNotificationOutboxState,
  attemptCount: NonNegativeInt,
  availableAt: Schema.String,
  leaseOwner: Schema.NullOr(Schema.String),
  leaseExpiresAt: Schema.NullOr(Schema.String),
  lastErrorCode: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  deliveredAt: Schema.NullOr(Schema.String),
});
export type HermesNotificationOutboxEntry = typeof HermesNotificationOutboxEntry.Type;
