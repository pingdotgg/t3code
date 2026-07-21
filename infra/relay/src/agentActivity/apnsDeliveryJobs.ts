import * as NodeCrypto from "node:crypto";

import { RelayAgentActivityAggregateState, type RelayDeliveryKind } from "@t3tools/contracts/relay";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const MAX_JOB_AGE_MS = 10 * 60 * 1_000;
export const APNS_DELIVERY_JOB_SIGNING_ALGORITHM = "hmac-sha256";

const ApnsDeliveryKind = Schema.Literals([
  "live_activity_start",
  "live_activity_update",
  "live_activity_end",
  "push_notification",
]);

export const ApnsNotificationPayload = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.String,
  deepLink: Schema.String,
});
export type ApnsNotificationPayload = typeof ApnsNotificationPayload.Type;

export const ApnsDeliveryJobPayload = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.String,
  kind: ApnsDeliveryKind,
  target: Schema.Struct({
    userId: Schema.String,
    deviceId: Schema.String,
    token: Schema.String,
  }),
  aggregate: Schema.NullOr(RelayAgentActivityAggregateState),
  notification: Schema.NullOr(ApnsNotificationPayload),
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export type ApnsDeliveryJobPayload = typeof ApnsDeliveryJobPayload.Type;

export const SignedApnsDeliveryJob = Schema.Struct({
  algorithm: Schema.Literal(APNS_DELIVERY_JOB_SIGNING_ALGORITHM),
  payload: ApnsDeliveryJobPayload,
  signature: Schema.String,
});
export type SignedApnsDeliveryJob = typeof SignedApnsDeliveryJob.Type;

export class ApnsDeliveryJobQueuePayloadInvalid extends Schema.TaggedErrorClass<ApnsDeliveryJobQueuePayloadInvalid>()(
  "ApnsDeliveryJobQueuePayloadInvalid",
  {},
) {
  override get message(): string {
    return "Invalid APNs delivery queue job.";
  }
}

export class ApnsDeliveryJobLiveActivityAggregateMissing extends Schema.TaggedErrorClass<ApnsDeliveryJobLiveActivityAggregateMissing>()(
  "ApnsDeliveryJobLiveActivityAggregateMissing",
  {},
) {
  override get message(): string {
    return "Live Activity start/update jobs require an aggregate.";
  }
}

export class ApnsDeliveryJobLiveActivityNotificationUnexpected extends Schema.TaggedErrorClass<ApnsDeliveryJobLiveActivityNotificationUnexpected>()(
  "ApnsDeliveryJobLiveActivityNotificationUnexpected",
  {},
) {
  override get message(): string {
    return "Live Activity jobs must not carry push notification payloads.";
  }
}

export class ApnsDeliveryJobPushNotificationMissing extends Schema.TaggedErrorClass<ApnsDeliveryJobPushNotificationMissing>()(
  "ApnsDeliveryJobPushNotificationMissing",
  {},
) {
  override get message(): string {
    return "Push notification jobs require a notification payload.";
  }
}

export class ApnsDeliveryJobPushNotificationAggregateUnexpected extends Schema.TaggedErrorClass<ApnsDeliveryJobPushNotificationAggregateUnexpected>()(
  "ApnsDeliveryJobPushNotificationAggregateUnexpected",
  {},
) {
  override get message(): string {
    return "Push notification jobs must not carry aggregate state.";
  }
}

export class ApnsDeliveryJobCreatedAtInvalid extends Schema.TaggedErrorClass<ApnsDeliveryJobCreatedAtInvalid>()(
  "ApnsDeliveryJobCreatedAtInvalid",
  {},
) {
  override get message(): string {
    return "Invalid APNs delivery job creation time.";
  }
}

export class ApnsDeliveryJobExpiresAtInvalid extends Schema.TaggedErrorClass<ApnsDeliveryJobExpiresAtInvalid>()(
  "ApnsDeliveryJobExpiresAtInvalid",
  {},
) {
  override get message(): string {
    return "Invalid APNs delivery job expiry.";
  }
}

export class ApnsDeliveryJobTimeWindowInvalid extends Schema.TaggedErrorClass<ApnsDeliveryJobTimeWindowInvalid>()(
  "ApnsDeliveryJobTimeWindowInvalid",
  {},
) {
  override get message(): string {
    return "Invalid APNs delivery job time window.";
  }
}

export class ApnsDeliveryJobTimeWindowTooLong extends Schema.TaggedErrorClass<ApnsDeliveryJobTimeWindowTooLong>()(
  "ApnsDeliveryJobTimeWindowTooLong",
  {},
) {
  override get message(): string {
    return "APNs delivery job time window is too long.";
  }
}

export class ApnsDeliveryJobSignatureInvalid extends Schema.TaggedErrorClass<ApnsDeliveryJobSignatureInvalid>()(
  "ApnsDeliveryJobSignatureInvalid",
  {},
) {
  override get message(): string {
    return "Invalid APNs delivery job signature.";
  }
}

export const ApnsDeliveryJobInvalid = Schema.Union([
  ApnsDeliveryJobQueuePayloadInvalid,
  ApnsDeliveryJobLiveActivityAggregateMissing,
  ApnsDeliveryJobLiveActivityNotificationUnexpected,
  ApnsDeliveryJobPushNotificationMissing,
  ApnsDeliveryJobPushNotificationAggregateUnexpected,
  ApnsDeliveryJobCreatedAtInvalid,
  ApnsDeliveryJobExpiresAtInvalid,
  ApnsDeliveryJobTimeWindowInvalid,
  ApnsDeliveryJobTimeWindowTooLong,
  ApnsDeliveryJobSignatureInvalid,
]);
export type ApnsDeliveryJobInvalid = typeof ApnsDeliveryJobInvalid.Type;

export class ApnsDeliveryJobExpired extends Schema.TaggedErrorClass<ApnsDeliveryJobExpired>()(
  "ApnsDeliveryJobExpired",
  {
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `APNs delivery job expired at ${this.expiresAt}`;
  }
}

export const ApnsDeliveryJobVerificationError = Schema.Union([
  ApnsDeliveryJobInvalid,
  ApnsDeliveryJobExpired,
]);
export type ApnsDeliveryJobVerificationError = typeof ApnsDeliveryJobVerificationError.Type;

export const isApnsDeliveryJobVerificationError = Schema.is(ApnsDeliveryJobVerificationError);

export function makeApnsDeliveryJobPayload(input: {
  readonly kind: RelayDeliveryKind;
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly aggregate: ApnsDeliveryJobPayload["aggregate"];
  readonly notification?: ApnsNotificationPayload | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly jobId: string;
}): ApnsDeliveryJobPayload {
  return {
    version: 1,
    jobId: input.jobId,
    kind: input.kind,
    target: {
      userId: input.userId,
      deviceId: input.deviceId,
      token: input.token,
    },
    aggregate: input.aggregate,
    notification: input.notification ?? null,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
}

export function expiresAtForJob(createdAtMs: number): string {
  return DateTime.formatIso(Option.getOrThrow(DateTime.make(createdAtMs + MAX_JOB_AGE_MS)));
}

function validatePayloadShape(payload: ApnsDeliveryJobPayload): ApnsDeliveryJobInvalid | null {
  switch (payload.kind) {
    case "live_activity_start":
    case "live_activity_update":
      if (payload.aggregate === null) {
        return new ApnsDeliveryJobLiveActivityAggregateMissing();
      }
      if (payload.notification !== null) {
        return new ApnsDeliveryJobLiveActivityNotificationUnexpected();
      }
      return null;
    case "live_activity_end":
      if (payload.notification !== null) {
        return new ApnsDeliveryJobLiveActivityNotificationUnexpected();
      }
      return null;
    case "push_notification":
      if (payload.notification === null) {
        return new ApnsDeliveryJobPushNotificationMissing();
      }
      if (payload.aggregate !== null) {
        return new ApnsDeliveryJobPushNotificationAggregateUnexpected();
      }
      return null;
  }
}

function signatureForPayload(input: {
  readonly secret: Redacted.Redacted<string>;
  readonly payload: ApnsDeliveryJobPayload;
}): string {
  return NodeCrypto.createHmac("sha256", Redacted.value(input.secret))
    .update(stableStringify(input.payload))
    .digest("base64url");
}

function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function signApnsDeliveryJob(input: {
  readonly secret: Redacted.Redacted<string>;
  readonly payload: ApnsDeliveryJobPayload;
}): SignedApnsDeliveryJob {
  return {
    algorithm: APNS_DELIVERY_JOB_SIGNING_ALGORITHM,
    payload: input.payload,
    signature: signatureForPayload(input),
  };
}

export function verifySignedApnsDeliveryJob(input: {
  readonly secret: Redacted.Redacted<string>;
  readonly job: SignedApnsDeliveryJob;
  readonly nowMs: number;
}): ApnsDeliveryJobPayload | ApnsDeliveryJobVerificationError {
  const invalidPayload = validatePayloadShape(input.job.payload);
  if (invalidPayload !== null) {
    return invalidPayload;
  }
  const createdAt = DateTime.make(input.job.payload.createdAt);
  if (Option.isNone(createdAt)) {
    return new ApnsDeliveryJobCreatedAtInvalid();
  }
  const expiresAt = DateTime.make(input.job.payload.expiresAt);
  if (Option.isNone(expiresAt)) {
    return new ApnsDeliveryJobExpiresAtInvalid();
  }
  const createdAtMs = createdAt.value.epochMilliseconds;
  const expiresAtMs = expiresAt.value.epochMilliseconds;
  if (expiresAtMs <= createdAtMs) {
    return new ApnsDeliveryJobTimeWindowInvalid();
  }
  if (expiresAtMs - createdAtMs > MAX_JOB_AGE_MS) {
    return new ApnsDeliveryJobTimeWindowTooLong();
  }
  if (expiresAtMs <= input.nowMs) {
    return new ApnsDeliveryJobExpired({ expiresAt: input.job.payload.expiresAt });
  }
  const expected = signatureForPayload({
    secret: input.secret,
    payload: input.job.payload,
  });
  if (!timingSafeEqualBase64Url(input.job.signature, expected)) {
    return new ApnsDeliveryJobSignatureInvalid();
  }
  return input.job.payload;
}
