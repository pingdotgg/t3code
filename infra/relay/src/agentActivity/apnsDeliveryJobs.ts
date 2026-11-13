import {
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPhase,
} from "@t3tools/contracts/relay";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Mac from "effect/crypto/Mac";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const MAX_JOB_AGE_MS = 10 * 60 * 1_000;
const APNS_DELIVERY_JOB_SIGNING_ALGORITHM = "hmac-sha256";

const ApnsDeliveryKindSchema = Schema.Literals([
  "live_activity_update",
  "live_activity_end",
  "push_notification",
]);
const LiveActivityStartOrUpdateKindSchema = Schema.Literals(["live_activity_update"]);
const LiveActivityKindSchema = Schema.Literals(["live_activity_update", "live_activity_end"]);

const ApnsDeliveryJobContext = {
  jobId: Schema.String,
  userId: Schema.String,
  deviceId: Schema.String,
};

export const ApnsNotificationPayload = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.String,
  deepLink: Schema.String,
  phase: Schema.optional(RelayAgentAwarenessPhase),
  updatedAt: Schema.optional(Schema.String),
});
export type ApnsNotificationPayload = typeof ApnsNotificationPayload.Type;

export const ApnsLiveActivityAlert = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
});
export type ApnsLiveActivityAlert = typeof ApnsLiveActivityAlert.Type;

export const ApnsDeliveryJobPayload = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.String,
  kind: ApnsDeliveryKindSchema,
  target: Schema.Struct({
    userId: Schema.String,
    deviceId: Schema.String,
    token: Schema.String,
    bundleId: Schema.optional(Schema.NullOr(Schema.String)),
    apsEnvironment: Schema.optional(Schema.NullOr(Schema.Literals(["sandbox", "production"]))),
  }),
  aggregate: Schema.NullOr(RelayAgentActivityAggregateState),
  notification: Schema.NullOr(ApnsNotificationPayload),
  alert: Schema.optional(Schema.NullOr(ApnsLiveActivityAlert)),
  // Environments the device hid when the aggregate was built.
  hiddenEnvironmentIds: Schema.optional(Schema.Array(Schema.String)),
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

export class ApnsDeliveryJobQueuePayloadInvalid extends Schema.TaggedError<ApnsDeliveryJobQueuePayloadInvalid>()(
  "ApnsDeliveryJobQueuePayloadInvalid",
  {
    receivedType: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid APNs delivery queue job with ${this.receivedType} payload.`;
  }
}

export class ApnsDeliveryJobLiveActivityAggregateMissing extends Schema.TaggedError<ApnsDeliveryJobLiveActivityAggregateMissing>()(
  "ApnsDeliveryJobLiveActivityAggregateMissing",
  {
    ...ApnsDeliveryJobContext,
    kind: LiveActivityStartOrUpdateKindSchema,
  },
) {
  override get message(): string {
    return `APNs ${this.kind.replaceAll("_", " ")} job ${this.jobId} requires an aggregate.`;
  }
}

export class ApnsDeliveryJobLiveActivityNotificationUnexpected extends Schema.TaggedError<ApnsDeliveryJobLiveActivityNotificationUnexpected>()(
  "ApnsDeliveryJobLiveActivityNotificationUnexpected",
  {
    ...ApnsDeliveryJobContext,
    kind: LiveActivityKindSchema,
  },
) {
  override get message(): string {
    return `APNs ${this.kind.replaceAll("_", " ")} job ${this.jobId} must not carry a push notification payload.`;
  }
}

export class ApnsDeliveryJobPushNotificationMissing extends Schema.TaggedError<ApnsDeliveryJobPushNotificationMissing>()(
  "ApnsDeliveryJobPushNotificationMissing",
  ApnsDeliveryJobContext,
) {
  override get message(): string {
    return `APNs push notification job ${this.jobId} requires a notification payload.`;
  }
}

export class ApnsDeliveryJobPushNotificationAggregateUnexpected extends Schema.TaggedError<ApnsDeliveryJobPushNotificationAggregateUnexpected>()(
  "ApnsDeliveryJobPushNotificationAggregateUnexpected",
  ApnsDeliveryJobContext,
) {
  override get message(): string {
    return `APNs push notification job ${this.jobId} must not carry aggregate state.`;
  }
}

export class ApnsDeliveryJobCreatedAtInvalid extends Schema.TaggedError<ApnsDeliveryJobCreatedAtInvalid>()(
  "ApnsDeliveryJobCreatedAtInvalid",
  {
    ...ApnsDeliveryJobContext,
    kind: ApnsDeliveryKindSchema,
    createdAt: Schema.String,
  },
) {
  override get message(): string {
    return `APNs delivery job ${this.jobId} has invalid creation time ${this.createdAt}.`;
  }
}

export class ApnsDeliveryJobExpiresAtInvalid extends Schema.TaggedError<ApnsDeliveryJobExpiresAtInvalid>()(
  "ApnsDeliveryJobExpiresAtInvalid",
  {
    ...ApnsDeliveryJobContext,
    kind: ApnsDeliveryKindSchema,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `APNs delivery job ${this.jobId} has invalid expiry ${this.expiresAt}.`;
  }
}

export class ApnsDeliveryJobTimeWindowInvalid extends Schema.TaggedError<ApnsDeliveryJobTimeWindowInvalid>()(
  "ApnsDeliveryJobTimeWindowInvalid",
  {
    ...ApnsDeliveryJobContext,
    kind: ApnsDeliveryKindSchema,
    createdAt: Schema.String,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `APNs delivery job ${this.jobId} has invalid time window ${this.createdAt} to ${this.expiresAt}.`;
  }
}

export class ApnsDeliveryJobTimeWindowTooLong extends Schema.TaggedError<ApnsDeliveryJobTimeWindowTooLong>()(
  "ApnsDeliveryJobTimeWindowTooLong",
  {
    ...ApnsDeliveryJobContext,
    kind: ApnsDeliveryKindSchema,
    createdAt: Schema.String,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `APNs delivery job ${this.jobId} time window ${this.createdAt} to ${this.expiresAt} is too long.`;
  }
}

export class ApnsDeliveryJobSignatureInvalid extends Schema.TaggedError<ApnsDeliveryJobSignatureInvalid>()(
  "ApnsDeliveryJobSignatureInvalid",
  {
    ...ApnsDeliveryJobContext,
    kind: ApnsDeliveryKindSchema,
  },
) {
  override get message(): string {
    return `Invalid signature for APNs delivery job ${this.jobId}.`;
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

export class ApnsDeliveryJobExpired extends Schema.TaggedError<ApnsDeliveryJobExpired>()(
  "ApnsDeliveryJobExpired",
  {
    ...ApnsDeliveryJobContext,
    kind: ApnsDeliveryKindSchema,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `APNs delivery job ${this.jobId} expired at ${this.expiresAt}.`;
  }
}

export const ApnsDeliveryJobVerificationError = Schema.Union([
  ApnsDeliveryJobInvalid,
  ApnsDeliveryJobExpired,
]);
export type ApnsDeliveryJobVerificationError = typeof ApnsDeliveryJobVerificationError.Type;

export function makeApnsDeliveryJobPayload(input: {
  readonly kind: ApnsDeliveryJobPayload["kind"];
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly bundleId?: string | null | undefined;
  readonly apsEnvironment?: "sandbox" | "production" | null | undefined;
  readonly aggregate: ApnsDeliveryJobPayload["aggregate"];
  readonly notification?: ApnsNotificationPayload | null;
  readonly alert?: ApnsLiveActivityAlert | null | undefined;
  readonly hiddenEnvironmentIds?: ReadonlyArray<string> | undefined;
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
      ...(input.bundleId ? { bundleId: input.bundleId } : {}),
      ...(input.apsEnvironment ? { apsEnvironment: input.apsEnvironment } : {}),
    },
    aggregate: input.aggregate,
    notification: input.notification ?? null,
    // Omit absent fields to preserve signatures from older relay builds.
    ...(input.alert ? { alert: input.alert } : {}),
    ...(input.hiddenEnvironmentIds?.length
      ? { hiddenEnvironmentIds: input.hiddenEnvironmentIds }
      : {}),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
}

export function expiresAtForJob(createdAtMs: number): string {
  return DateTime.formatIso(Option.getOrThrow(DateTime.make(createdAtMs + MAX_JOB_AGE_MS)));
}

function validatePayloadShape(payload: ApnsDeliveryJobPayload): ApnsDeliveryJobInvalid | null {
  switch (payload.kind) {
    case "live_activity_update":
      if (payload.aggregate === null) {
        return new ApnsDeliveryJobLiveActivityAggregateMissing({
          jobId: payload.jobId,
          kind: payload.kind,
          userId: payload.target.userId,
          deviceId: payload.target.deviceId,
        });
      }
      if (payload.notification !== null) {
        return new ApnsDeliveryJobLiveActivityNotificationUnexpected({
          jobId: payload.jobId,
          kind: payload.kind,
          userId: payload.target.userId,
          deviceId: payload.target.deviceId,
        });
      }
      return null;
    case "live_activity_end":
      if (payload.notification !== null) {
        return new ApnsDeliveryJobLiveActivityNotificationUnexpected({
          jobId: payload.jobId,
          kind: payload.kind,
          userId: payload.target.userId,
          deviceId: payload.target.deviceId,
        });
      }
      return null;
    case "push_notification":
      if (payload.notification === null) {
        return new ApnsDeliveryJobPushNotificationMissing({
          jobId: payload.jobId,
          userId: payload.target.userId,
          deviceId: payload.target.deviceId,
        });
      }
      if (payload.aggregate !== null) {
        return new ApnsDeliveryJobPushNotificationAggregateUnexpected({
          jobId: payload.jobId,
          userId: payload.target.userId,
          deviceId: payload.target.deviceId,
        });
      }
      return null;
  }
}

const signingKey = (secret: Redacted.Redacted<string>) =>
  Mac.key(Mac.hmacSha256, new TextEncoder().encode(Redacted.value(secret)));

const payloadBytes = (payload: ApnsDeliveryJobPayload) =>
  new TextEncoder().encode(stableStringify(payload));

export const signApnsDeliveryJob = Effect.fn("relay.apns_delivery_jobs.sign")(function* (input: {
  readonly secret: Redacted.Redacted<string>;
  readonly payload: ApnsDeliveryJobPayload;
}) {
  const mac = yield* Mac.Mac;
  const signature = yield* signingKey(input.secret).pipe(
    Effect.flatMap((key) => mac.sign(key, payloadBytes(input.payload))),
    Effect.orDie,
  );
  return {
    algorithm: APNS_DELIVERY_JOB_SIGNING_ALGORITHM,
    payload: input.payload,
    signature: Base64Url.encode(signature),
  } satisfies SignedApnsDeliveryJob;
});

export const verifySignedApnsDeliveryJob = Effect.fn("relay.apns_delivery_jobs.verify")(
  function* (input: {
    readonly secret: Redacted.Redacted<string>;
    readonly job: SignedApnsDeliveryJob;
    readonly nowMs: number;
  }) {
    const payload = input.job.payload;
    const invalid = validateSignedJobWindow(payload, input.nowMs);
    if (invalid !== null) {
      return yield* invalid;
    }
    const tag = Base64Url.decode(input.job.signature);
    const mac = yield* Mac.Mac;
    const verified =
      Result.isSuccess(tag) &&
      (yield* signingKey(input.secret).pipe(
        Effect.flatMap((key) => mac.verify(key, tag.success, payloadBytes(payload))),
        Effect.orDie,
      ));
    if (!verified) {
      return yield* new ApnsDeliveryJobSignatureInvalid({
        jobId: payload.jobId,
        kind: payload.kind,
        userId: payload.target.userId,
        deviceId: payload.target.deviceId,
      });
    }
    return payload;
  },
);

function validateSignedJobWindow(
  payload: ApnsDeliveryJobPayload,
  nowMs: number,
): ApnsDeliveryJobVerificationError | null {
  const invalidPayload = validatePayloadShape(payload);
  if (invalidPayload !== null) {
    return invalidPayload;
  }
  const createdAt = DateTime.make(payload.createdAt);
  if (Option.isNone(createdAt)) {
    return new ApnsDeliveryJobCreatedAtInvalid({
      jobId: payload.jobId,
      kind: payload.kind,
      userId: payload.target.userId,
      deviceId: payload.target.deviceId,
      createdAt: payload.createdAt,
    });
  }
  const expiresAt = DateTime.make(payload.expiresAt);
  if (Option.isNone(expiresAt)) {
    return new ApnsDeliveryJobExpiresAtInvalid({
      jobId: payload.jobId,
      kind: payload.kind,
      userId: payload.target.userId,
      deviceId: payload.target.deviceId,
      expiresAt: payload.expiresAt,
    });
  }
  const createdAtMs = createdAt.value.epochMilliseconds;
  const expiresAtMs = expiresAt.value.epochMilliseconds;
  if (expiresAtMs <= createdAtMs) {
    return new ApnsDeliveryJobTimeWindowInvalid({
      jobId: payload.jobId,
      kind: payload.kind,
      userId: payload.target.userId,
      deviceId: payload.target.deviceId,
      createdAt: payload.createdAt,
      expiresAt: payload.expiresAt,
    });
  }
  if (expiresAtMs - createdAtMs > MAX_JOB_AGE_MS) {
    return new ApnsDeliveryJobTimeWindowTooLong({
      jobId: payload.jobId,
      kind: payload.kind,
      userId: payload.target.userId,
      deviceId: payload.target.deviceId,
      createdAt: payload.createdAt,
      expiresAt: payload.expiresAt,
    });
  }
  if (expiresAtMs <= nowMs) {
    return new ApnsDeliveryJobExpired({
      jobId: payload.jobId,
      kind: payload.kind,
      userId: payload.target.userId,
      deviceId: payload.target.deviceId,
      expiresAt: payload.expiresAt,
    });
  }
  return null;
}
