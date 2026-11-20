import * as Schema from "effect/Schema";
import { RelayAgentActivityAggregateState } from "./relay.ts";
import { EnvironmentId, IsoDateTime } from "./baseSchemas.ts";

const Token = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]+$/), Schema.isMaxLength(1024));
export const DirectPushRegistration = Schema.Struct({
  deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  bundleId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  appScheme: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^t3code(?:-dev|-preview)?$/)),
  ),
  apsEnvironment: Schema.Literals(["sandbox", "production"]),
  pushToken: Schema.NullOr(Token),
  activityToken: Schema.NullOr(Token),
  notificationsEnabled: Schema.Boolean,
  liveActivitiesEnabled: Schema.Boolean,
});
export type DirectPushRegistration = typeof DirectPushRegistration.Type;

export const DirectPushDelivery = Schema.Struct({
  at: IsoDateTime,
  kind: Schema.Literals(["alert", "liveactivity", "background"]),
  /** Apple's HTTP status; 200 is accepted. Null when the request never got an answer from Apple. */
  status: Schema.NullOr(Schema.Int),
  /** Apple's rejection reason (for example BadDeviceToken), or the send error. */
  reason: Schema.NullOr(Schema.String),
});
export type DirectPushDelivery = typeof DirectPushDelivery.Type;

export const DirectPushStatus = Schema.Struct({
  configured: Schema.Boolean,
  bundleId: Schema.NullOr(Schema.String),
  registered: Schema.Boolean,
  activity: RelayAgentActivityAggregateState,
  // Optional so clients still decode status from servers that predate it.
  lastDelivery: Schema.optionalKey(DirectPushDelivery),
});
export type DirectPushStatus = typeof DirectPushStatus.Type;
export const DirectWidgetUpdate = Schema.Struct({
  environmentId: EnvironmentId,
  activity: RelayAgentActivityAggregateState,
  attentionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  approvalCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  activeProjectCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type DirectWidgetUpdate = typeof DirectWidgetUpdate.Type;
