import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as RelayDb from "../db.ts";
import { makePgliteRelayDb } from "../persistence/pgliteTestDb.ts";
import { relayLiveActivities, relayMobileDevices } from "../persistence/schema.ts";
import * as Devices from "./Devices.ts";

const deviceRow = (pushToken: string | null) => ({
  deviceId: "device-1",
  label: "Pixel 9",
  platform: "android",
  iosMajorVersion: null,
  androidApiLevel: 36,
  appVersion: "2.2.0",
  pushToken,
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
  updatedAt: "2026-10-28T00:00:00.000Z",
});

describe("Devices", () => {
  it.effect.each([
    [null, false],
    ["fcm-token", true],
  ] as const)("lists notifications for push token %s as enabled: %s", ([pushToken, enabled]) => {
    const fakeDb = {
      select: () => ({
        from: () => ({ where: () => Effect.succeed([deviceRow(pushToken)]) }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      const [device] = yield* devices.listForUser({ userId: "user-1" });

      expect(device?.notifications.enabled).toBe(enabled);
    }).pipe(
      Effect.provide(Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)))),
    );
  });

  it.effect("prunes devices that stayed unreachable for 30 days, with their Live Activity", () =>
    Effect.gen(function* () {
      const now = Date.parse("2026-06-01T00:00:00.000Z");
      yield* TestClock.setTime(now);
      const daysAgo = (days: number) =>
        DateTime.formatIso(DateTime.makeUnsafe(now - days * 86_400_000));
      const { db, layer } = yield* makePgliteRelayDb;
      const device = (deviceId: string, updatedAt: string, pushToken: string | null = null) => ({
        userId: "user-1",
        deviceId,
        platform: "ios" as const,
        pushToken,
        preferencesJson: deviceRow(null).preferences,
        createdAt: daysAgo(90),
        updatedAt,
      });
      yield* Effect.promise(() =>
        db
          .insert(relayMobileDevices)
          .values([
            device("stale", daysAgo(31)),
            device("stale-armed", daysAgo(31)),
            device("stale-recent-card", daysAgo(31)),
            device("recent", daysAgo(29)),
            device("reachable", daysAgo(31), "apns-token"),
          ]),
      );
      const liveActivity = (
        deviceId: string,
        activityPushToken: string | null,
        updatedAt = daysAgo(31),
      ) => ({
        userId: "user-1",
        deviceId,
        activityPushToken,
        createdAt: daysAgo(31),
        updatedAt,
      });
      yield* Effect.promise(() =>
        db.insert(relayLiveActivities).values([
          liveActivity("stale", null),
          liveActivity("stale-armed", "activity-token"),
          // An iPhone with notifications off that ended a card yesterday is still in use.
          liveActivity("stale-recent-card", null, daysAgo(1)),
        ]),
      );
      const devices = yield* Effect.service(Devices.Devices).pipe(
        Effect.provide(Devices.layer.pipe(Layer.provide(layer))),
      );

      expect(yield* devices.pruneTokenless).toBe(1);
      const remaining = yield* Effect.promise(() => db.select().from(relayMobileDevices));
      expect(remaining.map((row) => row.deviceId).toSorted()).toEqual([
        "reachable",
        "recent",
        "stale-armed",
        "stale-recent-card",
      ]);
      const activities = yield* Effect.promise(() => db.select().from(relayLiveActivities));
      expect(activities.map((row) => row.deviceId).toSorted()).toEqual([
        "stale-armed",
        "stale-recent-card",
      ]);
    }),
  );
});
