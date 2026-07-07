import type {
  RelayAgentActivityAggregateState,
  RelayDeliveryResult,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { sanitizeApnsNotificationPayload } from "./agentActivityPayloads.ts";
import * as Devices from "./Devices.ts";
import {
  FcmDeliveryJobQueuePayloadInvalid,
  SignedFcmDeliveryJob,
  isFcmDeliveryJobVerificationError,
  verifySignedFcmDeliveryJob,
  type FcmDeliveryJobVerificationError,
} from "./fcmDeliveryJobs.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as Fcm from "./FcmClient.ts";
import * as FcmDeliveryQueue from "./FcmDeliveryQueue.ts";
import * as LiveActivities from "./LiveActivities.ts";
import type { AndroidMobileTarget } from "./mobileTargets.ts";
import { fcmChannelIdForPhase, notificationForAggregate } from "./pushNotificationDelivery.ts";
import * as RelayConfiguration from "../Config.ts";
import { withSpanAttributes } from "../observability.ts";

const PERMANENT_FCM_TOKEN_STATUSES = new Set(["NOT_FOUND", "UNREGISTERED"]);

export type FcmDeliveryError =
  | FcmDeliveryQueue.FcmDeliveryQueueError
  | FcmDeliveryJobVerificationError
  | FcmDeliveryJobClaimInFlight
  | DeliveryAttempts.DeliveryAttemptRecordPersistenceError
  | Devices.DeviceListPersistenceError
  | LiveActivities.LiveActivityDeliveryMarkPersistenceError;

export class FcmDeliveryJobClaimInFlight extends Schema.TaggedErrorClass<FcmDeliveryJobClaimInFlight>()(
  "FcmDeliveryJobClaimInFlight",
  {
    sourceJobId: Schema.String,
  },
) {
  override get message(): string {
    return `FCM delivery job '${this.sourceJobId}' is already in flight`;
  }
}

export class FcmDeliveryTransportError extends Schema.TaggedErrorClass<FcmDeliveryTransportError>()(
  "FcmDeliveryTransportError",
  {
    deviceId: Schema.String,
    sourceJobId: Schema.NullOr(Schema.String),
    fcmErrorTag: Schema.Literals([
      "FcmJwtEncodingError",
      "FcmJwtSigningError",
      "FcmHttpRequestError",
    ]),
    requestStage: Schema.NullOr(Schema.Literals(["token", "send", "read-response"])),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `FCM push notification delivery failed for device ${this.deviceId}.`;
  }
}

export const isFcmDeliveryTransportError = Schema.is(FcmDeliveryTransportError);

function duplicateJobResult(deviceId: string): RelayDeliveryResult {
  return {
    deviceId,
    kind: "push_notification",
    ok: true,
    apnsStatus: null,
    apnsReason: "Duplicate FCM delivery job skipped.",
    apnsId: null,
  };
}

function staleJobResult(deviceId: string): RelayDeliveryResult {
  return {
    deviceId,
    kind: "push_notification",
    ok: true,
    apnsStatus: null,
    apnsReason: "Stale FCM delivery job skipped.",
    apnsId: null,
  };
}

function isPermanentFcmTokenFailure(result: Fcm.FcmDeliveryResult): boolean {
  return (
    !result.ok &&
    (result.status === 404 ||
      (result.reason !== undefined && PERMANENT_FCM_TOKEN_STATUSES.has(result.reason)))
  );
}

function deliveryAttemptOutcome(result: Fcm.FcmDeliveryResult) {
  return {
    ...(result.status === 0 ? {} : { apnsStatus: result.status }),
    ...(result.reason === undefined ? {} : { apnsReason: result.reason }),
    apnsId: result.messageId,
    ...(result.status === 0 ? { transportError: result.reason ?? "FCM request failed." } : {}),
  };
}

const recoverFcmDeliveryTransportError = (
  input: {
    readonly deviceId: string;
    readonly sourceJobId: string | null;
  },
  cause: Fcm.FcmError,
): Effect.Effect<Fcm.FcmDeliveryResult> => {
  const error = new FcmDeliveryTransportError({
    deviceId: input.deviceId,
    sourceJobId: input.sourceJobId,
    fcmErrorTag: cause._tag,
    requestStage: cause._tag === "FcmHttpRequestError" ? cause.stage : null,
    cause,
  });
  return Effect.logError(error.message).pipe(
    Effect.annotateLogs({
      error: Redacted.make(error, { label: error._tag }),
      "error.type": error._tag,
      "error.fcm_error_tag": error.fcmErrorTag,
      ...(error.requestStage === null ? {} : { "error.request_stage": error.requestStage }),
      ...(error.stack === undefined ? {} : { "error.stack": error.stack }),
      "relay.mobile.device_id": error.deviceId,
      "relay.delivery.kind": "push_notification",
      ...(error.sourceJobId === null ? {} : { "relay.delivery.job_id": error.sourceJobId }),
    }),
    Effect.as({
      ok: false,
      status: 0,
      reason: cause.message,
      messageId: null,
    }),
  );
};

interface PushNotificationDeliveryTarget {
  readonly user_id: string;
  readonly device_id: string;
}

export class FcmDeliveries extends Context.Service<
  FcmDeliveries,
  {
    readonly sendForTarget: (input: {
      readonly target: AndroidMobileTarget;
      readonly aggregate: RelayAgentActivityAggregateState | null;
    }) => Effect.Effect<RelayDeliveryResult | null, FcmDeliveryError>;
    readonly sendPushNotificationForTarget: (input: {
      readonly target: AndroidMobileTarget;
      readonly aggregate: RelayAgentActivityAggregateState | null;
    }) => Effect.Effect<RelayDeliveryResult | null, FcmDeliveryError>;
    readonly processSignedJob: (
      body: unknown,
    ) => Effect.Effect<RelayDeliveryResult, FcmDeliveryError>;
  }
>()("t3code-relay/agentActivity/FcmDeliveries") {}

const decodeSignedFcmDeliveryJob = Schema.decodeUnknownEffect(SignedFcmDeliveryJob);

export const make = Effect.gen(function* () {
  const attempts = yield* DeliveryAttempts.DeliveryAttempts;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const devices = yield* Devices.Devices;
  const deliveryQueue = yield* FcmDeliveryQueue.FcmDeliveryQueue;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const fcm = yield* Fcm.FcmClient;

  const fcmDeliveryEnabled =
    config.fcmDeliveryEnabled &&
    config.fcm !== null &&
    Redacted.value(config.fcm.privateKey) !== "";

  const isCurrentSignedJobToken = Effect.fnUntraced(function* (input: {
    readonly target: PushNotificationDeliveryTarget;
    readonly token: string;
  }) {
    const androidTargets = yield* devices.listAndroidPushTargets({ userId: input.target.user_id });
    const androidTarget = androidTargets.find((row) => row.device_id === input.target.device_id);
    return androidTarget?.push_token === input.token;
  });

  const sendPushNotification: (input: {
    readonly target: PushNotificationDeliveryTarget;
    readonly token: string;
    readonly sourceJobId?: string | null;
    readonly notification: Parameters<typeof sanitizeApnsNotificationPayload>[0];
    readonly channelId: string;
  }) => Effect.Effect<RelayDeliveryResult, FcmDeliveryError> = Effect.fn(
    "relay.fcm_deliveries.send_push_notification",
  )(function* (input) {
    if (!fcmDeliveryEnabled || config.fcm === null) {
      return {
        deviceId: input.target.device_id,
        kind: "push_notification" as const,
        ok: true,
        apnsStatus: null,
        apnsReason: "FCM delivery disabled.",
        apnsId: null,
      };
    }

    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": input.target.device_id,
      "relay.delivery.kind": "push_notification",
      ...(input.sourceJobId ? { "relay.delivery.job_id": input.sourceJobId } : {}),
      "relay.environment_id": input.notification.environmentId,
      "relay.thread_id": input.notification.threadId,
    });

    const now = yield* DateTime.now;
    const epochSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const notification = sanitizeApnsNotificationPayload(input.notification);
    const request = fcm.makePushNotificationRequest({
      token: input.token,
      notification,
      channelId: input.channelId,
    });

    const recoverTransportError = (cause: Fcm.FcmError) =>
      recoverFcmDeliveryTransportError(
        {
          deviceId: input.target.device_id,
          sourceJobId: input.sourceJobId ?? null,
        },
        cause,
      );

    if (input.sourceJobId) {
      const claim = yield* attempts.claimSourceJob({
        userId: input.target.user_id,
        environmentId: notification.environmentId,
        threadId: notification.threadId,
        deviceId: input.target.device_id,
        kind: "push_notification",
        sourceJobId: input.sourceJobId,
        token: input.token,
      });
      if (claim === "completed") {
        return duplicateJobResult(input.target.device_id);
      }
      if (claim === "in_flight") {
        return yield* new FcmDeliveryJobClaimInFlight({ sourceJobId: input.sourceJobId });
      }
      const tokenIsCurrent = yield* isCurrentSignedJobToken({
        target: input.target,
        token: input.token,
      });
      if (!tokenIsCurrent) {
        yield* attempts.completeSourceJob({
          sourceJobId: input.sourceJobId,
          apnsReason: "Stale FCM delivery job skipped.",
        });
        return staleJobResult(input.target.device_id);
      }
    }

    const result = yield* fcm
      .sendPushNotificationRequest({
        credentials: config.fcm,
        request,
        issuedAtUnixSeconds: epochSeconds,
      })
      .pipe(
        Effect.catchTags({
          FcmJwtEncodingError: recoverTransportError,
          FcmJwtSigningError: recoverTransportError,
          FcmHttpRequestError: recoverTransportError,
        }),
      );

    if (isPermanentFcmTokenFailure(result)) {
      yield* liveActivities.invalidateDeliveryToken({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
        kind: "push_notification",
        invalidatedAt: DateTime.formatIso(now),
      });
    }

    if (input.sourceJobId) {
      yield* attempts.completeSourceJob({
        sourceJobId: input.sourceJobId,
        ...deliveryAttemptOutcome(result),
      });
    } else {
      yield* attempts.record({
        userId: input.target.user_id,
        environmentId: notification.environmentId,
        threadId: notification.threadId,
        deviceId: input.target.device_id,
        kind: "push_notification",
        token: input.token,
        ...deliveryAttemptOutcome(result),
      });
    }

    return {
      deviceId: input.target.device_id,
      kind: "push_notification" as const,
      ok: result.ok,
      apnsStatus: result.status === 0 ? null : result.status,
      apnsReason: result.reason ?? null,
      apnsId: result.messageId,
    };
  });

  const processSignedJob: FcmDeliveries["Service"]["processSignedJob"] = Effect.fn(
    "relay.fcm_deliveries.process_signed_job",
  )(function* (body) {
    const signedJob = yield* decodeSignedFcmDeliveryJob(body).pipe(
      Effect.mapError(
        (cause) =>
          new FcmDeliveryJobQueuePayloadInvalid({
            receivedType: Array.isArray(body) ? "array" : body === null ? "null" : typeof body,
            cause,
          }),
      ),
    );
    const now = yield* DateTime.now;
    const payload = verifySignedFcmDeliveryJob({
      secret: config.fcmDeliveryJobSigningSecret,
      job: signedJob,
      nowMs: now.epochMilliseconds,
    });
    if (isFcmDeliveryJobVerificationError(payload)) {
      return yield* payload;
    }
    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": payload.target.deviceId,
      "relay.delivery.kind": payload.kind,
      "relay.delivery.job_id": payload.jobId,
    });
    return yield* sendPushNotification({
      target: {
        user_id: payload.target.userId,
        device_id: payload.target.deviceId,
      },
      token: payload.target.token,
      sourceJobId: payload.jobId,
      notification: payload.notification,
      channelId: payload.channelId,
    }).pipe(withSpanAttributes({ "user.id": payload.target.userId }));
  });

  const enqueueOrSendPush = Effect.fnUntraced(function* (input: {
    readonly target: AndroidMobileTarget;
    readonly aggregate: RelayAgentActivityAggregateState | null;
  }) {
    if (!fcmDeliveryEnabled) {
      return null;
    }
    const notification = notificationForAggregate({
      preferencesJson: input.target.preferences_json,
      pushToken: input.target.push_token,
      aggregate: input.aggregate,
    });
    const token = input.target.push_token;
    if (!notification || !token) {
      return null;
    }
    const phase = input.aggregate?.activities[0]?.phase ?? "running";
    return yield* deliveryQueue.enqueuePushNotification({
      userId: input.target.user_id,
      deviceId: input.target.device_id,
      token,
      notification,
      channelId: fcmChannelIdForPhase(phase),
    });
  });

  return FcmDeliveries.of({
    processSignedJob,
    sendForTarget: enqueueOrSendPush,
    sendPushNotificationForTarget: enqueueOrSendPush,
  });
});

export const layer = Layer.effect(FcmDeliveries, make);
