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
import { and, eq, sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayLiveActivities, relayMobileDevices } from "../persistence/schema.ts";

export class LiveActivityRegistrationPersistenceError extends Schema.TaggedErrorClass<LiveActivityRegistrationPersistenceError>()(
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

export class LiveActivityTargetListPersistenceError extends Schema.TaggedErrorClass<LiveActivityTargetListPersistenceError>()(
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

export class LiveActivityDeliveryMarkPersistenceError extends Schema.TaggedErrorClass<LiveActivityDeliveryMarkPersistenceError>()(
  "LiveActivityDeliveryMarkPersistenceError",
  {
    operation: Schema.Literals([
      "mark-delivery",
      "mark-start-queued",
      "clear-start-queued",
      "invalidate-delivery-token",
    ]),
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

export interface DeviceRow {
  readonly user_id: string;
  readonly device_id: string;
  readonly platform: "ios";
  readonly ios_major_version: number;
  readonly app_version: string | null;
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
    }) => Effect.Effect<void, LiveActivityRegistrationPersistenceError>;
    readonly listTargets: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<TargetRow>, LiveActivityTargetListPersistenceError>;
    readonly markDelivery: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly kind: RelayDeliveryKind;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly deliveredAt: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
    readonly markStartQueued: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly queuedAt: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
    readonly clearStartQueued: (input: {
      readonly userId: string;
      readonly deviceId: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
    readonly invalidateDeliveryToken: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly kind: RelayDeliveryKind;
      readonly invalidatedAt: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
  }
>()("t3code-relay/agentActivity/LiveActivities") {}

const decodeJsonString = Schema.decodeEffect(Schema.UnknownFromJsonString);
const encodeJsonValue = Schema.encodeEffect(Schema.UnknownFromJsonString);

const encodeRelayAgentActivityAggregateStateJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayAgentActivityAggregateStateSchema),
);

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return LiveActivities.of({
    register: Effect.fn("relay.live_activities.register")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.registration.deviceId,
      });
      yield* Effect.gen(function* () {
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const registration = input.registration;

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
            remoteStartedAt: updatedAt,
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
              remoteStartedAt: updatedAt,
              endedAt: null,
              lastAggregateJson: null,
              lastLiveActivityDeliveryAt: null,
              updatedAt,
            },
          });
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
    }),

    listTargets: Effect.fn("relay.live_activities.list_targets")(function* (input) {
      return yield* db
        .select({
          device_id: relayMobileDevices.deviceId,
          user_id: relayMobileDevices.userId,
          platform: relayMobileDevices.platform,
          ios_major_version: relayMobileDevices.iosMajorVersion,
          app_version: relayMobileDevices.appVersion,
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
            remoteStartedAt: input.kind === "live_activity_start" ? input.deliveredAt : null,
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
              remoteStartedAt: sql`coalesce(
                ${relayLiveActivities.remoteStartedAt},
                excluded.remote_started_at
              )`,
              remoteStartQueuedAt: null,
              endedAt:
                input.kind === "live_activity_start"
                  ? null
                  : input.kind === "live_activity_end"
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

    markStartQueued: Effect.fn("relay.live_activities.mark_start_queued")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
      });
      yield* db
        .insert(relayLiveActivities)
        .values({
          userId: input.userId,
          deviceId: input.deviceId,
          remoteStartQueuedAt: input.queuedAt,
          remoteStartedAt: null,
          endedAt: null,
          createdAt: input.queuedAt,
          updatedAt: input.queuedAt,
        })
        .onConflictDoUpdate({
          target: [relayLiveActivities.userId, relayLiveActivities.deviceId],
          set: {
            remoteStartQueuedAt: sql`coalesce(
              ${relayLiveActivities.remoteStartQueuedAt},
              excluded.remote_start_queued_at
            )`,
            endedAt: null,
            updatedAt: input.queuedAt,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new LiveActivityDeliveryMarkPersistenceError({
                operation: "mark-start-queued",
                userId: input.userId,
                deviceId: input.deviceId,
                kind: null,
                cause,
              }),
          ),
        );
    }),

    clearStartQueued: Effect.fn("relay.live_activities.clear_start_queued")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
      });
      yield* db
        .update(relayLiveActivities)
        .set({ remoteStartQueuedAt: null })
        .where(
          and(
            eq(relayLiveActivities.userId, input.userId),
            eq(relayLiveActivities.deviceId, input.deviceId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new LiveActivityDeliveryMarkPersistenceError({
                operation: "clear-start-queued",
                userId: input.userId,
                deviceId: input.deviceId,
                kind: null,
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

          if (input.kind === "live_activity_start") {
            yield* db
              .update(relayMobileDevices)
              .set({
                pushToStartToken: null,
                updatedAt: input.invalidatedAt,
              })
              .where(
                and(
                  eq(relayMobileDevices.userId, input.userId),
                  eq(relayMobileDevices.deviceId, input.deviceId),
                ),
              );
            yield* db
              .update(relayLiveActivities)
              .set({
                remoteStartQueuedAt: null,
                updatedAt: input.invalidatedAt,
              })
              .where(
                and(
                  eq(relayLiveActivities.userId, input.userId),
                  eq(relayLiveActivities.deviceId, input.deviceId),
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
  });
});

export const layer = Layer.effect(LiveActivities, make);
