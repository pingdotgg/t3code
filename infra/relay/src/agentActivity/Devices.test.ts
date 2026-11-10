import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as RelayDb from "../db.ts";
import { makeTestRelayDb } from "../persistence/testDatabase.ts";
import * as Devices from "./Devices.ts";
import * as LiveActivities from "./LiveActivities.ts";

const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: false,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const a = EnvironmentId.make("env-a");
const b = EnvironmentId.make("env-b");

describe("Devices", () => {
  it.effect("records when each environment is re-enabled for the delivery job lifetime", () =>
    Effect.gen(function* () {
      const db = yield* makeTestRelayDb;
      const services = Layer.mergeAll(Devices.layer, LiveActivities.layer).pipe(
        Layer.provide(Layer.succeed(RelayDb.RelayDb, db)),
      );
      yield* Effect.gen(function* () {
        const devices = yield* Devices.Devices;
        const liveActivities = yield* LiveActivities.LiveActivities;
        const register = (disabledEnvironmentIds: ReadonlyArray<EnvironmentId> | undefined) =>
          devices.register({
            userId: "user",
            registration: {
              deviceId: "phone",
              label: "Pixel",
              platform: "android",
              androidApiLevel: 35,
              pushToken: "fcm-token",
              preferences: {
                ...preferences,
                ...(disabledEnvironmentIds ? { disabledEnvironmentIds } : {}),
              },
            },
          });
        const revealedAt = liveActivities
          .listTargets({ userId: "user" })
          .pipe(Effect.map(([target]) => target?.environment_revealed_at));
        const at = (ms: number) => TestClock.setTime(ms);

        yield* register([a, b]);
        expect(yield* revealedAt).toBeNull();
        yield* at(1_000);
        yield* register([b]);
        expect(yield* revealedAt).toEqual({ [a]: 1_000 });
        // A refresh with unchanged preferences keeps the earlier re-enable time.
        yield* at(2_000);
        yield* register([b]);
        expect(yield* revealedAt).toEqual({ [a]: 1_000 });
        yield* at(3_000);
        yield* register(undefined);
        expect(yield* revealedAt).toEqual({ [a]: 1_000, [b]: 3_000 });
        // Entries outlive every job queued before them, then expire.
        yield* at(1_000 + 5 * 60_000 + 1);
        yield* register([a]);
        expect(yield* revealedAt).toEqual({ [b]: 3_000 });
        yield* at(400_000);
        yield* register([]);
        expect(yield* revealedAt).toEqual({ [a]: 400_000 });
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
