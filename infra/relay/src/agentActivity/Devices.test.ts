import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
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
});
