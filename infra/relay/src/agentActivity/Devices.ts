import type {
  RelayClientDeviceRecord,
  RelayDeviceRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayLiveActivities, relayMobileDevices } from "../persistence/schema.ts";

export class DeviceRegistrationPersistenceError extends Schema.TaggedErrorClass<DeviceRegistrationPersistenceError>()(
  "DeviceRegistrationPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    stage: Schema.Literals(["claim-push-token", "claim-push-to-start-token", "upsert-device"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist mobile device registration for ${this.userId}/${this.deviceId} during ${this.stage}.`;
  }
}

export class DeviceUnregistrationPersistenceError extends Schema.TaggedErrorClass<DeviceUnregistrationPersistenceError>()(
  "DeviceUnregistrationPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    stage: Schema.Literals(["delete-live-activity", "delete-device"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister mobile device ${this.userId}/${this.deviceId} during ${this.stage}.`;
  }
}

export class DeviceListPersistenceError extends Schema.TaggedErrorClass<DeviceListPersistenceError>()(
  "DeviceListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list mobile devices for ${this.userId}.`;
  }
}

export class Devices extends Context.Service<
  Devices,
  {
    readonly register: (input: {
      readonly userId: string;
      readonly registration: RelayDeviceRegistrationRequest;
    }) => Effect.Effect<void, DeviceRegistrationPersistenceError>;
    readonly unregister: (input: {
      readonly userId: string;
      readonly deviceId: string;
    }) => Effect.Effect<void, DeviceUnregistrationPersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<RelayClientDeviceRecord>, DeviceListPersistenceError>;
  }
>()("t3code-relay/agentActivity/Devices") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return Devices.of({
    register: Effect.fn("relay.devices.register")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.registration.deviceId,
      });
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const registration = input.registration;

      yield* Effect.all(
        [
          registration.pushToken
            ? db
                .update(relayMobileDevices)
                .set({ pushToken: null, updatedAt })
                .where(eq(relayMobileDevices.pushToken, registration.pushToken))
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new DeviceRegistrationPersistenceError({
                        userId: input.userId,
                        deviceId: registration.deviceId,
                        stage: "claim-push-token",
                        cause,
                      }),
                  ),
                )
            : Effect.void,
          registration.pushToStartToken
            ? db
                .update(relayMobileDevices)
                .set({ pushToStartToken: null, updatedAt })
                .where(eq(relayMobileDevices.pushToStartToken, registration.pushToStartToken))
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new DeviceRegistrationPersistenceError({
                        userId: input.userId,
                        deviceId: registration.deviceId,
                        stage: "claim-push-to-start-token",
                        cause,
                      }),
                  ),
                )
            : Effect.void,
        ],
        { discard: true },
      );

      yield* db
        .insert(relayMobileDevices)
        .values({
          userId: input.userId,
          deviceId: registration.deviceId,
          label: registration.label,
          platform: registration.platform,
          iosMajorVersion: registration.iosMajorVersion,
          appVersion: registration.appVersion ?? null,
          pushToken: registration.pushToken ?? null,
          pushToStartToken: registration.pushToStartToken ?? null,
          preferencesJson: registration.preferences,
          createdAt: updatedAt,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [relayMobileDevices.userId, relayMobileDevices.deviceId],
          set: {
            platform: registration.platform,
            label: registration.label,
            iosMajorVersion: registration.iosMajorVersion,
            appVersion: registration.appVersion ?? null,
            pushToken: sql`coalesce(excluded.push_token, ${relayMobileDevices.pushToken})`,
            pushToStartToken: sql`coalesce(
                excluded.push_to_start_token,
                ${relayMobileDevices.pushToStartToken}
              )`,
            preferencesJson: registration.preferences,
            updatedAt,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeviceRegistrationPersistenceError({
                userId: input.userId,
                deviceId: registration.deviceId,
                stage: "upsert-device",
                cause,
              }),
          ),
        );
    }),
    unregister: Effect.fn("relay.devices.unregister")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
      });
      yield* Effect.all(
        [
          db
            .delete(relayLiveActivities)
            .where(
              and(
                eq(relayLiveActivities.userId, input.userId),
                eq(relayLiveActivities.deviceId, input.deviceId),
              ),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new DeviceUnregistrationPersistenceError({
                    userId: input.userId,
                    deviceId: input.deviceId,
                    stage: "delete-live-activity",
                    cause,
                  }),
              ),
            ),
          db
            .delete(relayMobileDevices)
            .where(
              and(
                eq(relayMobileDevices.userId, input.userId),
                eq(relayMobileDevices.deviceId, input.deviceId),
              ),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new DeviceUnregistrationPersistenceError({
                    userId: input.userId,
                    deviceId: input.deviceId,
                    stage: "delete-device",
                    cause,
                  }),
              ),
            ),
        ],
        { discard: true },
      );
    }),
    listForUser: Effect.fn("relay.devices.listForUser")(function* (input) {
      const rows = yield* db
        .select({
          deviceId: relayMobileDevices.deviceId,
          label: relayMobileDevices.label,
          platform: relayMobileDevices.platform,
          iosMajorVersion: relayMobileDevices.iosMajorVersion,
          appVersion: relayMobileDevices.appVersion,
          preferences: relayMobileDevices.preferencesJson,
          updatedAt: relayMobileDevices.updatedAt,
        })
        .from(relayMobileDevices)
        .where(eq(relayMobileDevices.userId, input.userId))
        .pipe(
          Effect.mapError(
            (cause) => new DeviceListPersistenceError({ userId: input.userId, cause }),
          ),
        );
      return rows.map((row) => ({
        deviceId: row.deviceId,
        label: row.label,
        platform: row.platform,
        iosMajorVersion: row.iosMajorVersion,
        appVersion: row.appVersion,
        notifications: {
          enabled: row.preferences.notificationsEnabled,
          notifyOnApproval: row.preferences.notifyOnApproval,
          notifyOnInput: row.preferences.notifyOnInput,
          notifyOnCompletion: row.preferences.notifyOnCompletion,
          notifyOnFailure: row.preferences.notifyOnFailure,
          notifyOnBlocked: row.preferences.notifyOnBlocked ?? true,
        },
        liveActivities: {
          enabled: row.preferences.liveActivitiesEnabled,
        },
        updatedAt: row.updatedAt,
      }));
    }),
  });
});

export const layer = Layer.effect(Devices, make);
