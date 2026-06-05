import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayDb, type RelayDatabase } from "../db.ts";
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
    } as unknown as RelayDatabase;

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
    }).pipe(Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb, fakeDb)))));
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
    } as unknown as RelayDatabase;

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
    }).pipe(Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb, fakeDb)))));
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
    } as unknown as RelayDatabase;

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
          },
          liveActivities: {
            enabled: true,
          },
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb, fakeDb)))));
  });
});
