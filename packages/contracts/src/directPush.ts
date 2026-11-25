import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Push notifications the environment sends to Apple itself, with the user's own APNs key, for
// app builds signed with their own team. The relay path needs T3 Connect; this one only needs
// the phone to reach the environment once to register.

/** Development-signed builds get sandbox tokens; TestFlight and App Store builds production ones. */
export const DirectPushApsEnvironment = Schema.Literals(["sandbox", "production"]);
export type DirectPushApsEnvironment = typeof DirectPushApsEnvironment.Type;

export const DirectPushRegisterDeviceInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  /** The APNs topic: the app's bundle identifier. */
  bundleId: TrimmedNonEmptyString,
  apsEnvironment: DirectPushApsEnvironment,
});
export type DirectPushRegisterDeviceInput = typeof DirectPushRegisterDeviceInput.Type;

export const DirectPushUnregisterDeviceInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
});
export type DirectPushUnregisterDeviceInput = typeof DirectPushUnregisterDeviceInput.Type;

export const DirectPushCredentialsInput = Schema.Struct({
  teamId: TrimmedNonEmptyString,
  keyId: TrimmedNonEmptyString,
  /** The `.p8` file's PEM text. Never sent back to clients. */
  privateKey: TrimmedNonEmptyString,
});
export type DirectPushCredentialsInput = typeof DirectPushCredentialsInput.Type;

export const DirectPushDevice = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  bundleId: TrimmedNonEmptyString,
  apsEnvironment: DirectPushApsEnvironment,
  registeredAt: TrimmedNonEmptyString,
  /** APNs' reason for the last failed delivery, cleared by the next success. */
  lastError: Schema.NullOr(Schema.String),
});
export type DirectPushDevice = typeof DirectPushDevice.Type;

export const DirectPushStatus = Schema.Struct({
  credentials: Schema.NullOr(
    Schema.Struct({ teamId: TrimmedNonEmptyString, keyId: TrimmedNonEmptyString }),
  ),
  devices: Schema.Array(DirectPushDevice),
});
export type DirectPushStatus = typeof DirectPushStatus.Type;

export const DirectPushTestResult = Schema.Struct({
  deliveries: Schema.Array(
    Schema.Struct({
      deviceId: TrimmedNonEmptyString,
      label: TrimmedNonEmptyString,
      ok: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type DirectPushTestResult = typeof DirectPushTestResult.Type;

export class DirectPushError extends Schema.TaggedError<DirectPushError>()("DirectPushError", {
  reason: Schema.Literals(["invalid-credentials", "not-configured", "storage"]),
  message: Schema.String,
}) {}
