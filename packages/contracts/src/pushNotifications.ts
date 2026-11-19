import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PushApsEnvironment = Schema.Literals(["sandbox", "production"]);
export type PushApsEnvironment = typeof PushApsEnvironment.Type;

// The token is interpolated into the APNs request path, so only hex is accepted.
const ApnsDeviceToken = Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{32,200}$/));

export const PushDeviceRegistration = Schema.Struct({
  deviceId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  apnsToken: ApnsDeviceToken,
  apsEnvironment: PushApsEnvironment,
  bundleId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  platform: Schema.Literal("ios"),
  notificationsEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
});
export type PushDeviceRegistration = typeof PushDeviceRegistration.Type;

export const PushDeviceUnregistration = Schema.Struct({
  deviceId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type PushDeviceUnregistration = typeof PushDeviceUnregistration.Type;
