import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayLiveActivities, relayMobileDevices } from "../persistence/schema.ts";
import * as Devices from "./Devices.ts";

const registration: RelayDeviceRegistrationRequest = {
  deviceId: "device-1" as RelayDeviceRegistrationRequest["deviceId"],
  label: "Julius's iPhone",
  platform: "ios",
  iosMajorVersion: 18,
  appVersion: "1.0.0" as RelayDeviceRegistrationRequest["appVersion"],
  pushToken: "apns-device-token" as RelayDeviceRegistrationRequest["pushToken"],
  pushToStartToken: "push-to-start-token" as RelayDeviceRegistrationRequest["pushToStartToken"],
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

describe("Devices", () => {
  it.effect("claims APNs tokens globally before upserting the current user device", () => {
    const calls: Array<string> = [];
    const updateSets: Array<Record<string, unknown>> = [];
    const updateConditions: Array<SQL> = [];
    const insertedValues: Array<Record<string, unknown>> = [];
    const dialect = new PgDialect();

    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayMobileDevices);
        calls.push("update");
        return {
          set: (values: Record<string, unknown>) => {
            updateSets.push(values);
            calls.push("update.set");
            return {
              where: (condition: SQL) => {
                expect(condition).toBeDefined();
                updateConditions.push(condition);
                calls.push("update.where");
                return Effect.void;
              },
            };
          },
        };
      },
      insert: (table: unknown) => {
        expect(table).toBe(relayMobileDevices);
        calls.push("insert");
        return {
          values: (values: Record<string, unknown>) => {
            insertedValues.push(values);
            calls.push("insert.values");
            return {
              onConflictDoUpdate: (config: unknown) => {
                expect(config).toBeDefined();
                calls.push("insert.onConflictDoUpdate");
                return Effect.void;
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      yield* devices.register({ userId: "user-2", registration });

      expect(calls).toEqual([
        "update",
        "update.set",
        "update.where",
        "update",
        "update.set",
        "update.where",
        "insert",
        "insert.values",
        "insert.onConflictDoUpdate",
      ]);
      expect(updateSets).toEqual([
        expect.objectContaining({ pushToken: null }),
        expect.objectContaining({ pushToStartToken: null }),
      ]);
      expect(updateConditions.map((condition) => dialect.sqlToQuery(condition))).toEqual([
        {
          sql: '"relay_mobile_devices"."push_token" = $1',
          params: ["apns-device-token"],
        },
        {
          sql: '"relay_mobile_devices"."push_to_start_token" = $1',
          params: ["push-to-start-token"],
        },
      ]);
      expect(insertedValues).toEqual([
        expect.objectContaining({
          userId: "user-2",
          deviceId: "device-1",
          pushToken: "apns-device-token",
          pushToStartToken: "push-to-start-token",
        }),
      ]);
    }).pipe(
      Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)))),
    );
  });

  it.effect("unregisters APNs state only for the current user device", () => {
    const calls: Array<string> = [];
    const deleteConditions: Array<SQL> = [];
    const dialect = new PgDialect();

    const fakeDb = {
      delete: (table: unknown) => {
        calls.push(table === relayLiveActivities ? "delete.liveActivities" : "delete.devices");
        return {
          where: (condition: SQL) => {
            expect(condition).toBeDefined();
            deleteConditions.push(condition);
            calls.push("delete.where");
            return Effect.void;
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      yield* devices.unregister({ userId: "user-2", deviceId: "device-1" });

      expect(calls).toEqual([
        "delete.liveActivities",
        "delete.where",
        "delete.devices",
        "delete.where",
      ]);
      expect(deleteConditions.map((condition) => dialect.sqlToQuery(condition))).toEqual([
        {
          sql:
            '(("relay_live_activities"."user_id" = $1) and ' +
            '("relay_live_activities"."device_id" = $2))',
          params: ["user-2", "device-1"],
        },
        {
          sql:
            '(("relay_mobile_devices"."user_id" = $1) and ' +
            '("relay_mobile_devices"."device_id" = $2))',
          params: ["user-2", "device-1"],
        },
      ]);
    }).pipe(
      Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)))),
    );
  });

  it.effect("lists safe notification state without exposing APNs tokens", () => {
    const dialect = new PgDialect();
    let condition: SQL | null = null;
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayMobileDevices);
          return {
            where: (nextCondition: SQL) => {
              condition = nextCondition;
              return Effect.succeed([
                {
                  deviceId: "device-1",
                  label: "Julius's iPhone",
                  platform: "ios" as const,
                  iosMajorVersion: 18,
                  appVersion: "1.0.0",
                  preferences: registration.preferences,
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
              ]);
            },
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      const listed = yield* devices.listForUser({ userId: "user-2" });

      expect(condition).not.toBeNull();
      expect(dialect.sqlToQuery(condition!)).toEqual({
        sql: '"relay_mobile_devices"."user_id" = $1',
        params: ["user-2"],
      });
      expect(listed).toEqual([
        {
          deviceId: "device-1",
          label: "Julius's iPhone",
          platform: "ios",
          iosMajorVersion: 18,
          appVersion: "1.0.0",
          notifications: {
            enabled: true,
            notifyOnApproval: true,
            notifyOnInput: true,
            notifyOnCompletion: true,
            notifyOnFailure: true,
            notifyOnBlocked: true,
          },
          liveActivities: {
            enabled: true,
          },
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ]);
    }).pipe(
      Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)))),
    );
  });

  it.effect("identifies the failed device registration stage", () => {
    const cause = new Error("push-token claim failed");
    const fakeDb = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ("pushToken" in values ? Effect.fail(cause) : Effect.void),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      const error = yield* devices.register({ userId: "user-2", registration }).pipe(Effect.flip);

      expect(error).toMatchObject({
        userId: "user-2",
        deviceId: "device-1",
        stage: "claim-push-token",
      });
      expect(error.cause).toBe(cause);
      expect(error.message).toBe(
        "Failed to persist mobile device registration for user-2/device-1 during claim-push-token.",
      );
    }).pipe(
      Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)))),
    );
  });

  it.effect("identifies the failed device unregistration stage", () => {
    const cause = new Error("live activity delete failed");
    const fakeDb = {
      delete: (table: unknown) => ({
        where: () => (table === relayLiveActivities ? Effect.fail(cause) : Effect.void),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      const error = yield* devices
        .unregister({ userId: "user-2", deviceId: "device-1" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        userId: "user-2",
        deviceId: "device-1",
        stage: "delete-live-activity",
      });
      expect(error.cause).toBe(cause);
      expect(error.message).toBe(
        "Failed to unregister mobile device user-2/device-1 during delete-live-activity.",
      );
    }).pipe(
      Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)))),
    );
  });

  it.effect("attaches the user to device list failures", () => {
    const cause = new Error("device list failed");
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => Effect.fail(cause),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      const error = yield* devices.listForUser({ userId: "user-2" }).pipe(Effect.flip);

      expect(error).toMatchObject({ userId: "user-2" });
      expect(error.cause).toBe(cause);
      expect(error.message).toBe("Failed to list mobile devices for user-2.");
    }).pipe(
      Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)))),
    );
  });

  it.effect(
    "defaults notifyOnBlocked to true when the stored preferences JSON omits the field",
    () => {
      const preferencesWithoutBlocked = {
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
        // notifyOnBlocked intentionally absent
      };

      const fakeDb = {
        select: () => ({
          from: (_table: unknown) => ({
            where: (_condition: SQL) =>
              Effect.succeed([
                {
                  deviceId: "device-2",
                  label: "Old iPhone",
                  platform: "ios" as const,
                  iosMajorVersion: 18,
                  appVersion: "1.0.0",
                  preferences: preferencesWithoutBlocked,
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
              ]),
          }),
        }),
      } as unknown as RelayDb.RelayDb["Service"];

      return Effect.gen(function* () {
        const devices = yield* Devices.Devices;
        const listed = yield* devices.listForUser({ userId: "user-3" });

        expect(listed[0]?.notifications.notifyOnBlocked).toBe(true);
      }).pipe(Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)))));
    },
  );

  it.effect(
    "preserves notifyOnBlocked: false when the stored preferences JSON sets it to false",
    () => {
      const preferencesWithBlockedFalse = {
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
        notifyOnBlocked: false,
      };

      const fakeDb = {
        select: () => ({
          from: (_table: unknown) => ({
            where: (_condition: SQL) =>
              Effect.succeed([
                {
                  deviceId: "device-3",
                  label: "User iPhone",
                  platform: "ios" as const,
                  iosMajorVersion: 18,
                  appVersion: "1.0.0",
                  preferences: preferencesWithBlockedFalse,
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
              ]),
          }),
        }),
      } as unknown as RelayDb.RelayDb["Service"];

      return Effect.gen(function* () {
        const devices = yield* Devices.Devices;
        const listed = yield* devices.listForUser({ userId: "user-4" });

        expect(listed[0]?.notifications.notifyOnBlocked).toBe(false);
      }).pipe(Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)))));
    },
  );
});
