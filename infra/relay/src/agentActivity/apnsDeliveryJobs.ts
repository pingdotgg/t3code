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

export class ApnsDeliveryJobInvalid extends Schema.TaggedErrorClass<ApnsDeliveryJobInvalid>()(
  "ApnsDeliveryJobInvalid",
  {
    reason: Schema.Literals([
      "invalid-queue-payload",
      "missing-live-activity-aggregate",
      "unexpected-live-activity-notification",
      "missing-push-notification",
      "unexpected-push-notification-aggregate",
      "invalid-created-at",
      "invalid-expires-at",
      "invalid-time-window",
      "time-window-too-long",
      "invalid-signature",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-queue-payload":
        return "Invalid APNs delivery queue job.";
      case "missing-live-activity-aggregate":
        return "Live Activity start/update jobs require an aggregate.";
      case "unexpected-live-activity-notification":
        return "Live Activity jobs must not carry push notification payloads.";
      case "missing-push-notification":
        return "Push notification jobs require a notification payload.";
      case "unexpected-push-notification-aggregate":
        return "Push notification jobs must not carry aggregate state.";
      case "invalid-created-at":
        return "Invalid APNs delivery job creation time.";
      case "invalid-expires-at":
        return "Invalid APNs delivery job expiry.";
      case "invalid-time-window":
        return "Invalid APNs delivery job time window.";
      case "time-window-too-long":
        return "APNs delivery job time window is too long.";
      case "invalid-signature":
        return "Invalid APNs delivery job signature.";
    }
  }
}

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

export type ApnsDeliveryJobVerificationError = ApnsDeliveryJobInvalid | ApnsDeliveryJobExpired;

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
        return new ApnsDeliveryJobInvalid({
          reason: "missing-live-activity-aggregate",
        });
      }
      if (payload.notification !== null) {
        return new ApnsDeliveryJobInvalid({
          reason: "unexpected-live-activity-notification",
        });
      }
      return null;
    case "live_activity_end":
      if (payload.notification !== null) {
        return new ApnsDeliveryJobInvalid({
          reason: "unexpected-live-activity-notification",
        });
      }
      return null;
    case "push_notification":
      if (payload.notification === null) {
        return new ApnsDeliveryJobInvalid({
          reason: "missing-push-notification",
        });
      }
      if (payload.aggregate !== null) {
        return new ApnsDeliveryJobInvalid({
          reason: "unexpected-push-notification-aggregate",
        });
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
    return new ApnsDeliveryJobInvalid({ reason: "invalid-created-at" });
  }
  const expiresAt = DateTime.make(input.job.payload.expiresAt);
  if (Option.isNone(expiresAt)) {
    return new ApnsDeliveryJobInvalid({ reason: "invalid-expires-at" });
  }
  const createdAtMs = createdAt.value.epochMilliseconds;
  const expiresAtMs = expiresAt.value.epochMilliseconds;
  if (expiresAtMs <= createdAtMs) {
    return new ApnsDeliveryJobInvalid({ reason: "invalid-time-window" });
  }
  if (expiresAtMs - createdAtMs > MAX_JOB_AGE_MS) {
    return new ApnsDeliveryJobInvalid({ reason: "time-window-too-long" });
  }
  if (expiresAtMs <= input.nowMs) {
    return new ApnsDeliveryJobExpired({ expiresAt: input.job.payload.expiresAt });
  }
  const expected = signatureForPayload({
    secret: input.secret,
    payload: input.job.payload,
  });
  if (!timingSafeEqualBase64Url(input.job.signature, expected)) {
    return new ApnsDeliveryJobInvalid({ reason: "invalid-signature" });
  }
  return input.job.payload;
}
