import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as RelayDb from "../db.ts";
import * as Devices from "./Devices.ts";

describe("Devices", () => {
  it.effect("moves a widget credential without clearing the current device's push token", () => {
    const changes: Array<{ values: Record<string, unknown>; condition: SQL }> = [];
    let storedHash: unknown;
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: SQL) =>
            Effect.sync(() => {
              changes.push({ values, condition });
            }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: () =>
            Effect.sync(() => {
              storedHash = values.widgetAccessTokenHash;
            }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];
    return Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      yield* devices.register({
        userId: "user",
        registration: {
          deviceId: "device",
          label: "Phone",
          platform: "ios",
          iosMajorVersion: 18,
          widgetAccessToken: "a".repeat(32),
          preferences: {
            notificationsEnabled: false,
            liveActivitiesEnabled: false,
            notifyOnApproval: true,
            notifyOnInput: true,
            notifyOnCompletion: true,
            notifyOnFailure: true,
          },
        },
      });
      expect(changes).toHaveLength(1);
      expect(changes[0]?.values).toMatchObject({
        widgetAccessTokenHash: null,
        widgetPushToken: null,
      });
      const query = new PgDialect().sqlToQuery(changes[0]!.condition);
      expect(query.params).toEqual([storedHash, "user", "device"]);
      expect(query.sql).toContain('"widget_access_token_hash" = $1');
      expect(query.sql).toContain('"user_id" <> $2');
      expect(query.sql).toContain('"device_id" <> $3');
      expect(query.sql).toContain(" or ");
    }).pipe(Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)))));
  });
});
