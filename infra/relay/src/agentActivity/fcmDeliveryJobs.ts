import * as NodeCrypto from "node:crypto";

import { stableStringify } from "@t3tools/shared/relaySigning";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";

const MAX_JOB_AGE_MS = 10 * 60 * 1_000;
export const FCM_DELIVERY_JOB_SIGNING_ALGORITHM = "hmac-sha256";

const FcmDeliveryJobContext = {
  jobId: Schema.String,
  userId: Schema.String,
  deviceId: Schema.String,
};

export const FcmDeliveryJobPayload = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.String,
  kind: Schema.Literal("push_notification"),
  target: Schema.Struct({
    userId: Schema.String,
    deviceId: Schema.String,
    token: Schema.String,
  }),
  notification: ApnsNotificationPayload,
  channelId: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export type FcmDeliveryJobPayload = typeof FcmDeliveryJobPayload.Type;

export const SignedFcmDeliveryJob = Schema.Struct({
  algorithm: Schema.Literal(FCM_DELIVERY_JOB_SIGNING_ALGORITHM),
  payload: FcmDeliveryJobPayload,
  signature: Schema.String,
});
export type SignedFcmDeliveryJob = typeof SignedFcmDeliveryJob.Type;

export class FcmDeliveryJobQueuePayloadInvalid extends Schema.TaggedErrorClass<FcmDeliveryJobQueuePayloadInvalid>()(
  "FcmDeliveryJobQueuePayloadInvalid",
  {
    receivedType: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid FCM delivery queue job with ${this.receivedType} payload.`;
  }
}

export class FcmDeliveryJobCreatedAtInvalid extends Schema.TaggedErrorClass<FcmDeliveryJobCreatedAtInvalid>()(
  "FcmDeliveryJobCreatedAtInvalid",
  {
    ...FcmDeliveryJobContext,
    createdAt: Schema.String,
  },
) {
  override get message(): string {
    return `FCM delivery job ${this.jobId} has invalid creation time ${this.createdAt}.`;
  }
}

export class FcmDeliveryJobExpiresAtInvalid extends Schema.TaggedErrorClass<FcmDeliveryJobExpiresAtInvalid>()(
  "FcmDeliveryJobExpiresAtInvalid",
  {
    ...FcmDeliveryJobContext,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `FCM delivery job ${this.jobId} has invalid expiry ${this.expiresAt}.`;
  }
}

export class FcmDeliveryJobTimeWindowInvalid extends Schema.TaggedErrorClass<FcmDeliveryJobTimeWindowInvalid>()(
  "FcmDeliveryJobTimeWindowInvalid",
  {
    ...FcmDeliveryJobContext,
    createdAt: Schema.String,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `FCM delivery job ${this.jobId} has invalid time window ${this.createdAt} to ${this.expiresAt}.`;
  }
}

export class FcmDeliveryJobTimeWindowTooLong extends Schema.TaggedErrorClass<FcmDeliveryJobTimeWindowTooLong>()(
  "FcmDeliveryJobTimeWindowTooLong",
  {
    ...FcmDeliveryJobContext,
    createdAt: Schema.String,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `FCM delivery job ${this.jobId} time window ${this.createdAt} to ${this.expiresAt} is too long.`;
  }
}

export class FcmDeliveryJobSignatureInvalid extends Schema.TaggedErrorClass<FcmDeliveryJobSignatureInvalid>()(
  "FcmDeliveryJobSignatureInvalid",
  FcmDeliveryJobContext,
) {
  override get message(): string {
    return `Invalid signature for FCM delivery job ${this.jobId}.`;
  }
}

export const FcmDeliveryJobInvalid = Schema.Union([
  FcmDeliveryJobQueuePayloadInvalid,
  FcmDeliveryJobCreatedAtInvalid,
  FcmDeliveryJobExpiresAtInvalid,
  FcmDeliveryJobTimeWindowInvalid,
  FcmDeliveryJobTimeWindowTooLong,
  FcmDeliveryJobSignatureInvalid,
]);
export type FcmDeliveryJobInvalid = typeof FcmDeliveryJobInvalid.Type;

export class FcmDeliveryJobExpired extends Schema.TaggedErrorClass<FcmDeliveryJobExpired>()(
  "FcmDeliveryJobExpired",
  {
    ...FcmDeliveryJobContext,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `FCM delivery job ${this.jobId} expired at ${this.expiresAt}.`;
  }
}

export const FcmDeliveryJobVerificationError = Schema.Union([
  FcmDeliveryJobInvalid,
  FcmDeliveryJobExpired,
]);
export type FcmDeliveryJobVerificationError = typeof FcmDeliveryJobVerificationError.Type;

export const isFcmDeliveryJobVerificationError = Schema.is(FcmDeliveryJobVerificationError);

export function makeFcmDeliveryJobPayload(input: {
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly notification: ApnsNotificationPayload;
  readonly channelId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly jobId: string;
}): FcmDeliveryJobPayload {
  return {
    version: 1,
    jobId: input.jobId,
    kind: "push_notification",
    target: {
      userId: input.userId,
      deviceId: input.deviceId,
      token: input.token,
    },
    notification: input.notification,
    channelId: input.channelId,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
}

export function expiresAtForFcmJob(createdAtMs: number): string {
  return DateTime.formatIso(Option.getOrThrow(DateTime.make(createdAtMs + MAX_JOB_AGE_MS)));
}

function signatureForPayload(input: {
  readonly secret: Redacted.Redacted<string>;
  readonly payload: FcmDeliveryJobPayload;
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

export function signFcmDeliveryJob(input: {
  readonly secret: Redacted.Redacted<string>;
  readonly payload: FcmDeliveryJobPayload;
}): SignedFcmDeliveryJob {
  return {
    algorithm: FCM_DELIVERY_JOB_SIGNING_ALGORITHM,
    payload: input.payload,
    signature: signatureForPayload(input),
  };
}

export function verifySignedFcmDeliveryJob(input: {
  readonly secret: Redacted.Redacted<string>;
  readonly job: SignedFcmDeliveryJob;
  readonly nowMs: number;
}): FcmDeliveryJobPayload | FcmDeliveryJobVerificationError {
  const payload = input.job.payload;
  const createdAt = DateTime.make(payload.createdAt);
  if (Option.isNone(createdAt)) {
    return new FcmDeliveryJobCreatedAtInvalid({
      jobId: payload.jobId,
      userId: payload.target.userId,
      deviceId: payload.target.deviceId,
      createdAt: payload.createdAt,
    });
  }
  const expiresAt = DateTime.make(payload.expiresAt);
  if (Option.isNone(expiresAt)) {
    return new FcmDeliveryJobExpiresAtInvalid({
      jobId: payload.jobId,
      userId: payload.target.userId,
      deviceId: payload.target.deviceId,
      expiresAt: payload.expiresAt,
    });
  }
  const createdAtMs = createdAt.value.epochMilliseconds;
  const expiresAtMs = expiresAt.value.epochMilliseconds;
  if (expiresAtMs <= createdAtMs) {
    return new FcmDeliveryJobTimeWindowInvalid({
      jobId: payload.jobId,
      userId: payload.target.userId,
      deviceId: payload.target.deviceId,
      createdAt: payload.createdAt,
      expiresAt: payload.expiresAt,
    });
  }
  if (expiresAtMs - createdAtMs > MAX_JOB_AGE_MS) {
    return new FcmDeliveryJobTimeWindowTooLong({
      jobId: payload.jobId,
      userId: payload.target.userId,
      deviceId: payload.target.deviceId,
      createdAt: payload.createdAt,
      expiresAt: payload.expiresAt,
    });
  }
  if (expiresAtMs <= input.nowMs) {
    return new FcmDeliveryJobExpired({
      jobId: payload.jobId,
      userId: payload.target.userId,
      deviceId: payload.target.deviceId,
      expiresAt: payload.expiresAt,
    });
  }
  const expected = signatureForPayload({
    secret: input.secret,
    payload,
  });
  if (!timingSafeEqualBase64Url(input.job.signature, expected)) {
    return new FcmDeliveryJobSignatureInvalid({
      jobId: payload.jobId,
      userId: payload.target.userId,
      deviceId: payload.target.deviceId,
    });
  }
  return payload;
}
