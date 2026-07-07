import type {
  RelayAgentAwarenessPreferences,
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

import type { AndroidMobileTarget } from "./mobileTargets.ts";
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

const androidPreferences = (
  preferences: RelayAgentAwarenessPreferences,
): RelayAgentAwarenessPreferences => ({
  ...preferences,
  liveActivitiesEnabled: false,
});

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
    readonly listAndroidPushTargets: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<AndroidMobileTarget>, DeviceListPersistenceError>;
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
          registration.platform === "ios" && registration.pushToStartToken
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

      const preferencesJson =
        registration.platform === "android"
          ? androidPreferences(registration.preferences)
          : registration.preferences;

      yield* db
        .insert(relayMobileDevices)
        .values(
          registration.platform === "android"
            ? {
                userId: input.userId,
                deviceId: registration.deviceId,
                label: registration.label,
                platform: registration.platform,
                iosMajorVersion: null,
                androidSdkVersion: registration.androidSdkVersion,
                appVersion: registration.appVersion ?? null,
                pushToken: registration.pushToken ?? null,
                pushToStartToken: null,
                preferencesJson,
                createdAt: updatedAt,
                updatedAt,
              }
            : {
                userId: input.userId,
                deviceId: registration.deviceId,
                label: registration.label,
                platform: registration.platform,
                iosMajorVersion: registration.iosMajorVersion,
                androidSdkVersion: null,
                appVersion: registration.appVersion ?? null,
                pushToken: registration.pushToken ?? null,
                pushToStartToken: registration.pushToStartToken ?? null,
                preferencesJson,
                createdAt: updatedAt,
                updatedAt,
              },
        )
        .onConflictDoUpdate({
          target: [relayMobileDevices.userId, relayMobileDevices.deviceId],
          set:
            registration.platform === "android"
              ? {
                  platform: registration.platform,
                  label: registration.label,
                  iosMajorVersion: null,
                  androidSdkVersion: registration.androidSdkVersion,
                  appVersion: registration.appVersion ?? null,
                  pushToken: sql`coalesce(excluded.push_token, ${relayMobileDevices.pushToken})`,
                  pushToStartToken: null,
                  preferencesJson,
                  updatedAt,
                }
              : {
                  platform: registration.platform,
                  label: registration.label,
                  iosMajorVersion: registration.iosMajorVersion,
                  androidSdkVersion: null,
                  appVersion: registration.appVersion ?? null,
                  pushToken: sql`coalesce(excluded.push_token, ${relayMobileDevices.pushToken})`,
                  pushToStartToken: sql`coalesce(
                      excluded.push_to_start_token,
                      ${relayMobileDevices.pushToStartToken}
                    )`,
                  preferencesJson,
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
          androidSdkVersion: relayMobileDevices.androidSdkVersion,
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
      return rows.map((row) => {
        const notifications = {
          enabled: row.preferences.notificationsEnabled,
          notifyOnApproval: row.preferences.notifyOnApproval,
          notifyOnInput: row.preferences.notifyOnInput,
          notifyOnCompletion: row.preferences.notifyOnCompletion,
          notifyOnFailure: row.preferences.notifyOnFailure,
        };
        if (row.platform === "android") {
          return {
            deviceId: row.deviceId,
            label: row.label,
            platform: "android" as const,
            androidSdkVersion: row.androidSdkVersion!,
            appVersion: row.appVersion,
            notifications,
            liveActivities: {
              enabled: false as const,
            },
            updatedAt: row.updatedAt,
          };
        }
        return {
          deviceId: row.deviceId,
          label: row.label,
          platform: "ios" as const,
          iosMajorVersion: row.iosMajorVersion!,
          appVersion: row.appVersion,
          notifications,
          liveActivities: {
            enabled: row.preferences.liveActivitiesEnabled,
          },
          updatedAt: row.updatedAt,
        };
      });
    }),
    listAndroidPushTargets: Effect.fn("relay.devices.list_android_push_targets")(function* (input) {
      const rows = yield* db
        .select({
          deviceId: relayMobileDevices.deviceId,
          pushToken: relayMobileDevices.pushToken,
          preferences: relayMobileDevices.preferencesJson,
        })
        .from(relayMobileDevices)
        .where(
          and(
            eq(relayMobileDevices.userId, input.userId),
            eq(relayMobileDevices.platform, "android"),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new DeviceListPersistenceError({ userId: input.userId, cause }),
          ),
        );
      return rows.map(
        (row): AndroidMobileTarget => ({
          user_id: input.userId,
          device_id: row.deviceId,
          platform: "android",
          push_token: row.pushToken,
          preferences_json: JSON.stringify(row.preferences),
        }),
      );
    }),
  });
});

export const layer = Layer.effect(Devices, make);
