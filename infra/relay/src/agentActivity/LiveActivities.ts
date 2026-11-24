import type {
  RelayAgentActivityAggregateState,
  RelayDeliveryKind,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import {
  RelayAgentActivityAggregateState as RelayAgentActivityAggregateStateSchema,
  RelayDeliveryKind as RelayDeliveryKindSchema,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayLiveActivities, relayMobileDevices } from "../persistence/schema.ts";

export class LiveActivityRegistrationPersistenceError extends Schema.TaggedError<LiveActivityRegistrationPersistenceError>()(
  "LiveActivityRegistrationPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist Live Activity registration for user ${this.userId} and device ${this.deviceId}.`;
  }
}

export class LiveActivityTargetListPersistenceError extends Schema.TaggedError<LiveActivityTargetListPersistenceError>()(
  "LiveActivityTargetListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list Live Activity delivery targets for user ${this.userId}.`;
  }
}

export class LiveActivityIdleTargetListPersistenceError extends Schema.TaggedError<LiveActivityIdleTargetListPersistenceError>()(
  "LiveActivityIdleTargetListPersistenceError",
  {
    deliveredBefore: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list idle Live Activities delivered before ${this.deliveredBefore}.`;
  }
}

export class LiveActivityDeliveryMarkPersistenceError extends Schema.TaggedError<LiveActivityDeliveryMarkPersistenceError>()(
  "LiveActivityDeliveryMarkPersistenceError",
  {
    operation: Schema.Literals(["mark-delivery", "invalidate-delivery-token"]),
    userId: Schema.String,
    deviceId: Schema.String,
    kind: Schema.NullOr(RelayDeliveryKindSchema),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist Live Activity state during ${this.operation} for user ${this.userId} and device ${this.deviceId}.`;
  }
}

// Pruned or unregistered devices must register again, or listTargets never sees their Live Activity.
export class LiveActivityDeviceNotRegisteredError extends Schema.TaggedError<LiveActivityDeviceNotRegisteredError>()(
  "LiveActivityDeviceNotRegisteredError",
  {
    deviceId: Schema.String,
  },
) {
  override get message(): string {
    return `Mobile device ${this.deviceId} is not registered.`;
  }
}

export class LiveActivityAggregatePrunePersistenceError extends Schema.TaggedError<LiveActivityAggregatePrunePersistenceError>()(
  "LiveActivityAggregatePrunePersistenceError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to clear the last aggregate of ended Live Activities.";
  }
}

// Outlasts the finished-row display window, the only time an ended baseline still suppresses a replayed alert.
export const ENDED_LIVE_ACTIVITY_AGGREGATE_RETENTION_MINUTES = 60;

export interface DeviceRow {
  readonly user_id: string;
  readonly device_id: string;
  readonly platform: "ios" | "android";
  readonly ios_major_version: number | null;
  readonly app_version: string | null;
  readonly bundle_id: string | null;
  readonly aps_environment: "sandbox" | "production" | null;
  readonly push_token: string | null;
  readonly push_to_start_token: string | null;
  readonly preferences_json: string;
}

export interface LiveActivityRow {
  readonly activity_push_token: string | null;
  readonly remote_start_queued_at: string | null;
  readonly remote_started_at: string | null;
  readonly ended_at: string | null;
  readonly last_aggregate_json: string | null;
  readonly last_live_activity_delivery_at: string | null;
}

export type TargetRow = DeviceRow & LiveActivityRow;

export class LiveActivities extends Context.Service<
  LiveActivities,
  {
    readonly register: (input: {
      readonly userId: string;
      readonly registration: RelayLiveActivityRegistrationRequest;
    }) => Effect.Effect<
      void,
      LiveActivityRegistrationPersistenceError | LiveActivityDeviceNotRegisteredError
    >;
    readonly listTargets: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<TargetRow>, LiveActivityTargetListPersistenceError>;
    readonly listIdleArmedTargets: (input: {
      readonly deliveredBefore: string;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly user_id: string; readonly device_id: string }>,
      LiveActivityIdleTargetListPersistenceError
    >;
    readonly markDelivery: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly kind: Exclude<RelayDeliveryKind, "live_activity_start">;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly deliveredAt: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
    readonly invalidateDeliveryToken: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly kind: Exclude<RelayDeliveryKind, "live_activity_start">;
      readonly invalidatedAt: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
    /** Drops the thread and project titles kept on activities that ended and stayed ended. */
    readonly clearEndedAggregates: Effect.Effect<void, LiveActivityAggregatePrunePersistenceError>;
  }
>()("t3code-relay/agentActivity/LiveActivities") {}

const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJsonValue = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const encodeRelayAgentActivityAggregateStateJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayAgentActivityAggregateStateSchema),
);

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return LiveActivities.of({
    register: Effect.fn("relay.live_activities.register")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.registration.deviceId,
      });
      const registered = yield* Effect.gen(function* () {
        const [device] = yield* db
          .select({ deviceId: relayMobileDevices.deviceId })
          .from(relayMobileDevices)
          .where(
            and(
              eq(relayMobileDevices.userId, input.userId),
              eq(relayMobileDevices.deviceId, input.registration.deviceId),
            ),
          );
        if (!device) return false;
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const registration = input.registration;
        const [current] = yield* db
          .select({
            activityPushToken: relayLiveActivities.activityPushToken,
            remoteStartedAt: relayLiveActivities.remoteStartedAt,
          })
          .from(relayLiveActivities)
          .where(
            and(
              eq(relayLiveActivities.userId, input.userId),
              eq(relayLiveActivities.deviceId, registration.deviceId),
            ),
          );
        // Foreground token refresh must retain the original arming time or grace can swallow an owed end event.
        const armedAt =
          (current?.activityPushToken === registration.activityPushToken
            ? current.remoteStartedAt
            : null) ?? updatedAt;

        yield* db
          .update(relayLiveActivities)
          .set({
            activityPushToken: null,
            remoteStartQueuedAt: null,
            remoteStartedAt: null,
            endedAt: updatedAt,
            updatedAt,
          })
          .where(eq(relayLiveActivities.activityPushToken, registration.activityPushToken));

        yield* db
          .insert(relayLiveActivities)
          .values({
            userId: input.userId,
            deviceId: registration.deviceId,
            activityPushToken: registration.activityPushToken,
            remoteStartQueuedAt: null,
            remoteStartedAt: armedAt,
            endedAt: null,
            lastAggregateJson: null,
            lastLiveActivityDeliveryAt: null,
            createdAt: updatedAt,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: [relayLiveActivities.userId, relayLiveActivities.deviceId],
            set: {
              activityPushToken: registration.activityPushToken,
              remoteStartQueuedAt: null,
              remoteStartedAt: armedAt,
              endedAt: null,
              lastAggregateJson: null,
              lastLiveActivityDeliveryAt: null,
              updatedAt,
            },
          });
        return true;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new LiveActivityRegistrationPersistenceError({
              userId: input.userId,
              deviceId: input.registration.deviceId,
              cause,
            }),
        ),
      );
      if (!registered) {
        return yield* new LiveActivityDeviceNotRegisteredError({
          deviceId: input.registration.deviceId,
        });
      }
    }),

    listTargets: Effect.fn("relay.live_activities.list_targets")(function* (input) {
      return yield* db
        .select({
          device_id: relayMobileDevices.deviceId,
          user_id: relayMobileDevices.userId,
          platform: relayMobileDevices.platform,
          ios_major_version: relayMobileDevices.iosMajorVersion,
          app_version: relayMobileDevices.appVersion,
          bundle_id: relayMobileDevices.bundleId,
          aps_environment: relayMobileDevices.apsEnvironment,
          push_token: relayMobileDevices.pushToken,
          push_to_start_token: relayMobileDevices.pushToStartToken,
          preferences_json: relayMobileDevices.preferencesJson,
          activity_push_token: relayLiveActivities.activityPushToken,
          remote_start_queued_at: relayLiveActivities.remoteStartQueuedAt,
          remote_started_at: relayLiveActivities.remoteStartedAt,
          ended_at: relayLiveActivities.endedAt,
          last_aggregate_json: relayLiveActivities.lastAggregateJson,
          last_live_activity_delivery_at: relayLiveActivities.lastLiveActivityDeliveryAt,
        })
        .from(relayMobileDevices)
        .leftJoin(
          relayLiveActivities,
          and(
            eq(relayLiveActivities.userId, relayMobileDevices.userId),
            eq(relayLiveActivities.deviceId, relayMobileDevices.deviceId),
          ),
        )
        .where(eq(relayMobileDevices.userId, input.userId))
        .pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(
              rows,
              (row) =>
                Effect.all({
                  preferences_json: encodeJsonValue(row.preferences_json),
                  last_aggregate_json:
                    row.last_aggregate_json === null
                      ? Effect.succeed(null)
                      : encodeJsonValue(row.last_aggregate_json),
                }).pipe(
                  Effect.map((json) => ({
                    ...row,
                    ...json,
                  })),
                ),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map((rows): ReadonlyArray<TargetRow> => rows),
          Effect.mapError(
            (cause) =>
              new LiveActivityTargetListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),

    listIdleArmedTargets: Effect.fn("relay.live_activities.list_idle_armed_targets")(
      function* (input) {
        return yield* db
          .select({
            user_id: relayLiveActivities.userId,
            device_id: relayLiveActivities.deviceId,
          })
          .from(relayLiveActivities)
          .where(
            and(
              isNotNull(relayLiveActivities.activityPushToken),
              sql`coalesce(${relayLiveActivities.lastLiveActivityDeliveryAt}, ${relayLiveActivities.remoteStartedAt}, ${relayLiveActivities.updatedAt}) < ${input.deliveredBefore}`,
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new LiveActivityIdleTargetListPersistenceError({
                  deliveredBefore: input.deliveredBefore,
                  cause,
                }),
            ),
          );
      },
    ),

    markDelivery: Effect.fn("relay.live_activities.mark_delivery")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
        "relay.delivery.kind": input.kind,
      });
      yield* Effect.gen(function* () {
        const aggregateJson =
          input.aggregate === null
            ? null
            : yield* encodeRelayAgentActivityAggregateStateJson(input.aggregate).pipe(
                Effect.flatMap(decodeJsonString),
                Effect.map(Function.cast<unknown, RelayAgentActivityAggregateState>),
              );

        yield* db
          .insert(relayLiveActivities)
          .values({
            userId: input.userId,
            deviceId: input.deviceId,
            remoteStartedAt: null,
            remoteStartQueuedAt: null,
            endedAt: input.kind === "live_activity_end" ? input.deliveredAt : null,
            lastAggregateJson: aggregateJson,
            lastLiveActivityDeliveryAt: input.deliveredAt,
            createdAt: input.deliveredAt,
            updatedAt: input.deliveredAt,
          })
          .onConflictDoUpdate({
            target: [relayLiveActivities.userId, relayLiveActivities.deviceId],
            set: {
              activityPushToken:
                input.kind === "live_activity_update"
                  ? sql`${relayLiveActivities.activityPushToken}`
                  : null,
              remoteStartedAt: sql`coalesce(
                      ${relayLiveActivities.remoteStartedAt},
                      excluded.remote_started_at
                    )`,
              remoteStartQueuedAt: null,
              endedAt:
                input.kind === "live_activity_end"
                  ? input.deliveredAt
                  : relayLiveActivities.endedAt,
              lastAggregateJson: aggregateJson,
              lastLiveActivityDeliveryAt: input.deliveredAt,
              updatedAt: input.deliveredAt,
            },
          });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new LiveActivityDeliveryMarkPersistenceError({
              operation: "mark-delivery",
              userId: input.userId,
              deviceId: input.deviceId,
              kind: input.kind,
              cause,
            }),
        ),
      );
    }),

    invalidateDeliveryToken: Effect.fn("relay.live_activities.invalidate_delivery_token")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.mobile.device_id": input.deviceId,
          "relay.delivery.kind": input.kind,
        });
        yield* Effect.gen(function* () {
          if (input.kind === "push_notification") {
            yield* db
              .update(relayMobileDevices)
              .set({
                pushToken: null,
                updatedAt: input.invalidatedAt,
              })
              .where(
                and(
                  eq(relayMobileDevices.userId, input.userId),
                  eq(relayMobileDevices.deviceId, input.deviceId),
                ),
              );
            return;
          }

          yield* db
            .update(relayLiveActivities)
            .set({
              activityPushToken: null,
              remoteStartQueuedAt: null,
              remoteStartedAt: null,
              endedAt: input.invalidatedAt,
              updatedAt: input.invalidatedAt,
            })
            .where(
              and(
                eq(relayLiveActivities.userId, input.userId),
                eq(relayLiveActivities.deviceId, input.deviceId),
              ),
            );
        }).pipe(
          Effect.mapError(
            (cause) =>
              new LiveActivityDeliveryMarkPersistenceError({
                operation: "invalidate-delivery-token",
                userId: input.userId,
                deviceId: input.deviceId,
                kind: input.kind,
                cause,
              }),
          ),
        );
      },
    ),

    clearEndedAggregates: Effect.gen(function* () {
      const before = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, {
          minutes: ENDED_LIVE_ACTIVITY_AGGREGATE_RETENTION_MINUTES,
        }),
      );
      yield* Effect.annotateCurrentSpan({ "relay.live_activities_prune.before": before });
      yield* db
        .update(relayLiveActivities)
        .set({ lastAggregateJson: null })
        .where(
          and(
            isNotNull(relayLiveActivities.lastAggregateJson),
            lt(relayLiveActivities.updatedAt, before),
            // Android updates keep the old endedAt, so a delivery after it means the card is live again.
            gte(relayLiveActivities.endedAt, relayLiveActivities.lastLiveActivityDeliveryAt),
          ),
        );
    }).pipe(
      Effect.mapError((cause) => new LiveActivityAggregatePrunePersistenceError({ cause })),
      Effect.withSpan("relay.live_activities.clear_ended_aggregates"),
    ),
  });
});

export const layer = Layer.effect(LiveActivities, make);
