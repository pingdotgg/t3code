import type {
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
  RelayDeliveryKind,
  RelayDeliveryResult,
} from "@t3tools/contracts/relay";
import {
  RelayAgentActivityAggregateState as RelayAgentActivityAggregateStateSchema,
  RelayAgentAwarenessPreferences as RelayAgentAwarenessPreferencesSchema,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  sanitizeAgentActivityAggregateState,
  sanitizeApnsNotificationPayload,
} from "./agentActivityPayloads.ts";
import * as Apns from "./ApnsClient.ts";
import {
  ApnsDeliveryJobInvalid,
  type ApnsNotificationPayload,
  SignedApnsDeliveryJob,
  verifySignedApnsDeliveryJob,
  type ApnsDeliveryJobVerificationError,
} from "./apnsDeliveryJobs.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import { withSpanAttributes } from "../observability.ts";

const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
const PERMANENT_APNS_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

type LiveActivityDeliveryKind = Extract<
  RelayDeliveryKind,
  "live_activity_start" | "live_activity_update" | "live_activity_end"
>;

type ChosenLiveActivityDelivery =
  | {
      readonly kind: "live_activity_start" | "live_activity_update";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState;
    }
  | {
      readonly kind: "live_activity_end";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState | null;
    };

type ChosenPushNotificationDelivery = {
  readonly kind: "push_notification";
  readonly token: string;
  readonly notification: ApnsNotificationPayload;
};

type ChosenDelivery = ChosenLiveActivityDelivery | ChosenPushNotificationDelivery;

export type ApnsDeliveryError =
  | ApnsDeliveryQueue.ApnsDeliveryQueueError
  | ApnsDeliveryJobVerificationError
  | ApnsDeliveryJobClaimInFlight
  | DeliveryAttempts.DeliveryAttemptRecordPersistenceError
  | LiveActivities.LiveActivityTargetListPersistenceError
  | LiveActivities.LiveActivityDeliveryMarkPersistenceError;

export class ApnsDeliveryJobClaimInFlight extends Schema.TaggedErrorClass<ApnsDeliveryJobClaimInFlight>()(
  "ApnsDeliveryJobClaimInFlight",
  {
    sourceJobId: Schema.String,
  },
) {
  override get message(): string {
    return `APNs delivery job '${this.sourceJobId}' is already in flight`;
  }
}

const decodeRelayAgentActivityAggregateStateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivityAggregateStateSchema),
);
const decodeRelayAgentAwarenessPreferencesJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferencesSchema),
);
const decodeSignedApnsDeliveryJob = Schema.decodeUnknownEffect(SignedApnsDeliveryJob);

function apnsErrorMessage(error: Apns.ApnsError): string {
  switch (error._tag) {
    case "ApnsSigningError":
      return "Failed to sign APNs request.";
    case "ApnsHttpRequestError":
      return "Failed to send APNs request.";
    case "ApnsInvalidResponseError":
      return "APNs returned an invalid response.";
  }
}

function parseAggregate(value: string | null): RelayAgentActivityAggregateState | null {
  if (!value) {
    return null;
  }
  return Option.getOrNull(decodeRelayAgentActivityAggregateStateJson(value));
}

function parsePreferences(value: string): RelayAgentAwarenessPreferences | null {
  return Option.getOrNull(decodeRelayAgentAwarenessPreferencesJson(value));
}

function shouldUpdateLiveActivity(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly lastDeliveryAt: string | null;
  readonly nowMs: number;
}): boolean {
  if (!input.previousAggregate) {
    return true;
  }
  if (input.previousAggregate.activeCount !== input.nextAggregate.activeCount) {
    return true;
  }
  if (JSON.stringify(input.previousAggregate) === JSON.stringify(input.nextAggregate)) {
    return false;
  }
  const lastDeliveryAtMs =
    input.lastDeliveryAt === null
      ? null
      : Option.match(DateTime.make(input.lastDeliveryAt), {
          onNone: () => Number.NaN,
          onSome: (dt) => dt.epochMilliseconds,
        });
  return (
    lastDeliveryAtMs === null ||
    Number.isNaN(lastDeliveryAtMs) ||
    input.nowMs - lastDeliveryAtMs >= MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS
  );
}

function notificationForAggregate(input: {
  readonly target: LiveActivities.TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
}): ApnsNotificationPayload | null {
  if (!input.target.push_token || input.aggregate === null) {
    return null;
  }
  const preferences = parsePreferences(input.target.preferences_json);
  if (!preferences?.notificationsEnabled) {
    return null;
  }
  const activity = input.aggregate.activities[0];
  if (!activity) {
    return null;
  }
  const enabled =
    (activity.phase === "waiting_for_approval" && preferences.notifyOnApproval) ||
    (activity.phase === "waiting_for_input" && preferences.notifyOnInput) ||
    (activity.phase === "completed" && preferences.notifyOnCompletion) ||
    (activity.phase === "failed" && preferences.notifyOnFailure);
  if (!enabled) {
    return null;
  }
  return {
    title: activity.threadTitle,
    body: `${activity.status}: ${activity.projectTitle}`,
    environmentId: activity.environmentId,
    threadId: activity.threadId,
    deepLink: activity.deepLink,
  };
}

function chooseLiveActivityDelivery(input: {
  readonly target: LiveActivities.TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
}): ChosenLiveActivityDelivery | null {
  const hasActiveActivity =
    input.target.ended_at === null &&
    (input.target.remote_start_queued_at !== null ||
      input.target.remote_started_at !== null ||
      input.target.activity_push_token !== null);
  const preferences = parsePreferences(input.target.preferences_json);
  if (preferences?.liveActivitiesEnabled === false) {
    return hasActiveActivity && input.target.activity_push_token
      ? {
          kind: "live_activity_end",
          token: input.target.activity_push_token,
          aggregate: null,
        }
      : null;
  }
  if (input.aggregate === null || input.aggregate.activeCount === 0) {
    return hasActiveActivity && input.target.activity_push_token
      ? {
          kind: "live_activity_end",
          token: input.target.activity_push_token,
          aggregate: input.aggregate,
        }
      : null;
  }
  if (!hasActiveActivity) {
    return input.target.push_to_start_token
      ? {
          kind: "live_activity_start",
          token: input.target.push_to_start_token,
          aggregate: input.aggregate,
        }
      : null;
  }
  if (!input.target.activity_push_token) {
    return null;
  }
  return shouldUpdateLiveActivity({
    previousAggregate: parseAggregate(input.target.last_aggregate_json),
    nextAggregate: input.aggregate,
    lastDeliveryAt: input.target.last_live_activity_delivery_at,
    nowMs: input.nowMs,
  }) ||
    input.aggregate.activities.some(
      (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
    )
    ? {
        kind: "live_activity_update",
        token: input.target.activity_push_token,
        aggregate: input.aggregate,
      }
    : null;
}

function chooseDelivery(input: {
  readonly target: LiveActivities.TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
}): ChosenDelivery | null {
  const liveActivityDelivery = chooseLiveActivityDelivery(input);
  if (liveActivityDelivery) {
    return liveActivityDelivery;
  }
  const notification = notificationForAggregate(input);
  return notification && input.target.push_token
    ? {
        kind: "push_notification",
        token: input.target.push_token,
        notification,
      }
    : null;
}

function deliveryEvent(kind: LiveActivityDeliveryKind): Apns.ApnsLiveActivityEvent {
  switch (kind) {
    case "live_activity_start":
      return "start";
    case "live_activity_update":
      return "update";
    case "live_activity_end":
      return "end";
  }
}

function isPermanentApnsTokenFailure(result: Apns.ApnsDeliveryResult): boolean {
  return (
    !result.ok &&
    (result.status === 410 ||
      (result.status === 400 &&
        result.reason !== undefined &&
        PERMANENT_APNS_TOKEN_REASONS.has(result.reason)))
  );
}

function isDeliveryJobVerificationError(value: unknown): value is ApnsDeliveryJobVerificationError {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    (value._tag === "ApnsDeliveryJobInvalid" || value._tag === "ApnsDeliveryJobExpired")
  );
}

function duplicateJobResult(input: {
  readonly deviceId: string;
  readonly kind: RelayDeliveryKind;
}): RelayDeliveryResult {
  return {
    deviceId: input.deviceId,
    kind: input.kind,
    ok: true,
    apnsStatus: null,
    apnsReason: "Duplicate APNs delivery job skipped.",
    apnsId: null,
  };
}

function staleJobResult(input: {
  readonly deviceId: string;
  readonly kind: RelayDeliveryKind;
}): RelayDeliveryResult {
  return {
    deviceId: input.deviceId,
    kind: input.kind,
    ok: true,
    apnsStatus: null,
    apnsReason: "Stale APNs delivery job skipped.",
    apnsId: null,
  };
}

function deliveryAttemptOutcome(result: Apns.ApnsDeliveryResult) {
  return {
    ...(result.status === 0 ? {} : { apnsStatus: result.status }),
    ...(result.reason === undefined ? {} : { apnsReason: result.reason }),
    apnsId: result.apnsId,
    ...(result.status === 0 ? { transportError: result.reason ?? "APNs request failed." } : {}),
  };
}

interface LiveActivityDeliveryTarget {
  readonly user_id: string;
  readonly device_id: string;
}

function expectedCurrentToken(input: {
  readonly target: LiveActivities.TargetRow;
  readonly kind: RelayDeliveryKind;
}): string | null {
  switch (input.kind) {
    case "live_activity_start":
      return input.target.push_to_start_token;
    case "live_activity_update":
    case "live_activity_end":
      return input.target.activity_push_token;
    case "push_notification":
      return input.target.push_token;
  }
}

interface SendLiveActivityDeliveryInputBase {
  readonly target: LiveActivityDeliveryTarget;
  readonly token: string;
  readonly sourceJobId?: string | null;
}

export type SendLiveActivityDeliveryInput =
  | (SendLiveActivityDeliveryInputBase & {
      readonly kind: "live_activity_start" | "live_activity_update";
      readonly aggregate: RelayAgentActivityAggregateState;
    })
  | (SendLiveActivityDeliveryInputBase & {
      readonly kind: "live_activity_end";
      readonly aggregate: RelayAgentActivityAggregateState | null;
    });

function makeLiveActivityDeliveryRequest(
  apns: Apns.ApnsClientShape,
  input: SendLiveActivityDeliveryInput,
  now: DateTime.DateTime,
) {
  const epochSeconds = Math.floor(now.epochMilliseconds / 1_000);
  const base = {
    token: input.token,
    nowEpochSeconds: epochSeconds,
    nowIso: DateTime.formatIso(now),
  };
  switch (input.kind) {
    case "live_activity_start":
    case "live_activity_update":
      return {
        epochSeconds,
        iso: base.nowIso,
        request: apns.makeLiveActivityRequest({
          ...base,
          event: deliveryEvent(input.kind),
          state: input.aggregate,
        }),
      };
    case "live_activity_end":
      return {
        epochSeconds,
        iso: base.nowIso,
        request: apns.makeLiveActivityRequest({
          ...base,
          event: "end",
          state: input.aggregate,
        }),
      };
  }
}

export interface ApnsDeliveriesShape {
  readonly sendForTarget: (input: {
    readonly target: LiveActivities.TargetRow;
    readonly aggregate: RelayAgentActivityAggregateState | null;
    readonly nowMs: number;
  }) => Effect.Effect<RelayDeliveryResult | null, ApnsDeliveryError>;
  readonly sendPushNotificationForTarget: (input: {
    readonly target: LiveActivities.TargetRow;
    readonly aggregate: RelayAgentActivityAggregateState | null;
  }) => Effect.Effect<RelayDeliveryResult | null, ApnsDeliveryError>;
  readonly sendLiveActivity: (
    input: SendLiveActivityDeliveryInput,
  ) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
  readonly processSignedJob: (
    body: unknown,
  ) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
  readonly sendPushNotification: (input: {
    readonly target: LiveActivityDeliveryTarget;
    readonly token: string;
    readonly sourceJobId?: string | null;
    readonly notification: ApnsNotificationPayload;
  }) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
}

export class ApnsDeliveries extends Context.Service<ApnsDeliveries, ApnsDeliveriesShape>()(
  "t3code-relay/agentActivity/ApnsDeliveries",
) {}

const make = Effect.gen(function* () {
  const attempts = yield* DeliveryAttempts.DeliveryAttempts;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const deliveryQueue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const apns = yield* Apns.ApnsClient;

  const isCurrentSignedJobToken = Effect.fnUntraced(function* (input: {
    readonly target: LiveActivityDeliveryTarget;
    readonly kind: RelayDeliveryKind;
    readonly token: string;
  }) {
    return yield* liveActivities.listTargets({ userId: input.target.user_id }).pipe(
      Effect.map((targets) => {
        const currentTarget = targets.find((row) => row.device_id === input.target.device_id);
        return (
          currentTarget !== undefined &&
          expectedCurrentToken({ target: currentTarget, kind: input.kind }) === input.token
        );
      }),
    );
  });

  const sendLiveActivity: ApnsDeliveriesShape["sendLiveActivity"] = Effect.fn(
    "relay.apns_deliveries.send_live_activity",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": input.target.device_id,
      "relay.delivery.kind": input.kind,
      ...(input.sourceJobId ? { "relay.delivery.job_id": input.sourceJobId } : {}),
    });
    const now = yield* DateTime.now;
    const aggregate =
      input.aggregate === null ? null : sanitizeAgentActivityAggregateState(input.aggregate);
    const { epochSeconds, iso, request } = makeLiveActivityDeliveryRequest(
      apns,
      { ...input, aggregate } as SendLiveActivityDeliveryInput,
      now,
    );
    if (input.sourceJobId) {
      const claim = yield* attempts.claimSourceJob({
        userId: input.target.user_id,
        environmentId: null,
        threadId: null,
        deviceId: input.target.device_id,
        kind: input.kind,
        sourceJobId: input.sourceJobId,
        token: input.token,
      });
      if (claim === "completed") {
        return duplicateJobResult({ deviceId: input.target.device_id, kind: input.kind });
      }
      if (claim === "in_flight") {
        return yield* new ApnsDeliveryJobClaimInFlight({ sourceJobId: input.sourceJobId });
      }
      const tokenIsCurrent = yield* isCurrentSignedJobToken({
        target: input.target,
        kind: input.kind,
        token: input.token,
      });
      if (!tokenIsCurrent) {
        yield* attempts.completeSourceJob({
          sourceJobId: input.sourceJobId,
          apnsReason: "Stale APNs delivery job skipped.",
        });
        return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
      }
    }
    const result = yield* apns
      .sendLiveActivityRequest({
        credentials: config.apns,
        request,
        issuedAtUnixSeconds: epochSeconds,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            ok: false,
            status: 0,
            reason: apnsErrorMessage(error),
            apnsId: null,
          }),
        ),
      );
    if (result.ok) {
      yield* liveActivities.markDelivery({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
        kind: input.kind,
        aggregate,
        deliveredAt: iso,
      });
    } else if (isPermanentApnsTokenFailure(result)) {
      yield* liveActivities.invalidateDeliveryToken({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
        kind: input.kind,
        invalidatedAt: iso,
      });
    } else if (input.kind === "live_activity_start") {
      yield* liveActivities.clearStartQueued({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
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
        environmentId: null,
        threadId: null,
        deviceId: input.target.device_id,
        kind: input.kind,
        token: input.token,
        ...deliveryAttemptOutcome(result),
      });
    }
    return {
      deviceId: input.target.device_id,
      kind: input.kind,
      ok: result.ok,
      apnsStatus: result.status === 0 ? null : result.status,
      apnsReason: result.reason ?? null,
      apnsId: result.apnsId,
    };
  });

  const sendPushNotification: ApnsDeliveriesShape["sendPushNotification"] = Effect.fn(
    "relay.apns_deliveries.send_push_notification",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": input.target.device_id,
      "relay.delivery.kind": "push_notification",
      ...(input.sourceJobId ? { "relay.delivery.job_id": input.sourceJobId } : {}),
    });
    const now = yield* DateTime.now;
    const epochSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const notification = sanitizeApnsNotificationPayload(input.notification);
    yield* Effect.annotateCurrentSpan({
      "relay.environment_id": notification.environmentId,
      "relay.thread_id": notification.threadId,
    });
    const request = apns.makePushNotificationRequest({
      token: input.token,
      notification,
    });
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
        return duplicateJobResult({
          deviceId: input.target.device_id,
          kind: "push_notification",
        });
      }
      if (claim === "in_flight") {
        return yield* new ApnsDeliveryJobClaimInFlight({ sourceJobId: input.sourceJobId });
      }
      const tokenIsCurrent = yield* isCurrentSignedJobToken({
        target: input.target,
        kind: "push_notification",
        token: input.token,
      });
      if (!tokenIsCurrent) {
        yield* attempts.completeSourceJob({
          sourceJobId: input.sourceJobId,
          apnsReason: "Stale APNs delivery job skipped.",
        });
        return staleJobResult({
          deviceId: input.target.device_id,
          kind: "push_notification",
        });
      }
    }
    const result = yield* apns
      .sendPushNotificationRequest({
        credentials: config.apns,
        request,
        issuedAtUnixSeconds: epochSeconds,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            ok: false,
            status: 0,
            reason: apnsErrorMessage(error),
            apnsId: null,
          }),
        ),
      );
    if (isPermanentApnsTokenFailure(result)) {
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
      apnsId: result.apnsId,
    };
  });

  const processSignedJob: ApnsDeliveriesShape["processSignedJob"] = Effect.fn(
    "relay.apns_deliveries.process_signed_job",
  )(function* (body) {
    const signedJob = yield* decodeSignedApnsDeliveryJob(body).pipe(
      Effect.mapError(
        () =>
          new ApnsDeliveryJobInvalid({
            message: "Invalid APNs delivery queue job.",
          }),
      ),
    );
    const now = yield* DateTime.now;
    const payload = verifySignedApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      job: signedJob,
      nowMs: now.epochMilliseconds,
    });
    if (isDeliveryJobVerificationError(payload)) {
      return yield* payload;
    }
    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": payload.target.deviceId,
      "relay.delivery.kind": payload.kind,
      "relay.delivery.job_id": payload.jobId,
    });
    return yield* Effect.suspend(() => {
      switch (payload.kind) {
        case "live_activity_start":
        case "live_activity_update":
          if (payload.aggregate === null) {
            return Effect.fail(
              new ApnsDeliveryJobInvalid({
                message: "Live Activity start/update jobs require an aggregate.",
              }),
            );
          }
          return sendLiveActivity({
            target: {
              user_id: payload.target.userId,
              device_id: payload.target.deviceId,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            kind: payload.kind,
            aggregate: payload.aggregate,
          });
        case "live_activity_end":
          return sendLiveActivity({
            target: {
              user_id: payload.target.userId,
              device_id: payload.target.deviceId,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            kind: payload.kind,
            aggregate: payload.aggregate,
          });
        case "push_notification":
          if (payload.notification === null) {
            return Effect.fail(
              new ApnsDeliveryJobInvalid({
                message: "Push notification jobs require a notification payload.",
              }),
            );
          }
          return sendPushNotification({
            target: {
              user_id: payload.target.userId,
              device_id: payload.target.deviceId,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            notification: payload.notification,
          });
      }
    }).pipe(withSpanAttributes({ "user.id": payload.target.userId }));
  });

  return ApnsDeliveries.of({
    sendLiveActivity,
    sendPushNotification,
    processSignedJob,
    sendPushNotificationForTarget: Effect.fnUntraced(function* (input) {
      const notification = notificationForAggregate(input);
      const token = input.target.push_token;
      return yield* notification && token
        ? deliveryQueue.enqueuePushNotification({
            userId: input.target.user_id,
            deviceId: input.target.device_id,
            token,
            notification,
          })
        : Effect.succeed(null);
    }),
    sendForTarget: Effect.fnUntraced(function* (input) {
      const delivery = chooseDelivery({
        target: input.target,
        aggregate: input.aggregate,
        nowMs: input.nowMs,
      });
      if (!delivery) {
        return null;
      }
      if (delivery.kind === "push_notification") {
        const result = yield* deliveryQueue.enqueuePushNotification({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          token: delivery.token,
          notification: delivery.notification,
        });
        return result;
      }
      const result = yield* deliveryQueue.enqueueLiveActivity({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
        kind: delivery.kind,
        token: delivery.token,
        aggregate: delivery.aggregate,
      });
      const notification = notificationForAggregate({
        target: input.target,
        aggregate: input.aggregate,
      });
      if (delivery.kind === "live_activity_end" && notification && input.target.push_token) {
        yield* deliveryQueue.enqueuePushNotification({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          token: input.target.push_token,
          notification,
        });
      }
      if (delivery.kind === "live_activity_start") {
        const now = yield* DateTime.now;
        yield* liveActivities.markStartQueued({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          queuedAt: DateTime.formatIso(now),
        });
      }
      return result;
    }),
  });
});

export const layer = Layer.effect(ApnsDeliveries, make);
