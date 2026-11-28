import type {
  RelayAgentActivityAggregateState,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as RelayDb from "../db.ts";
import { makePgliteRelayDb } from "../persistence/pgliteTestDb.ts";
import { relayLiveActivities } from "../persistence/schema.ts";
import * as LiveActivities from "./LiveActivities.ts";

const aggregate: RelayAgentActivityAggregateState = {
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "2026-05-25T00:00:00.000Z",
  activities: [
    {
      environmentId:
        "env" as RelayAgentActivityAggregateState["activities"][number]["environmentId"],
      threadId: "thread" as RelayAgentActivityAggregateState["activities"][number]["threadId"],
      projectTitle: "Project",
      threadTitle: "Thread",
      modelTitle: "gpt-5.4",
      phase: "running",
      status: "Working",
      updatedAt: "2026-05-25T00:00:00.000Z",
      deepLink: "/threads/env/thread",
    },
  ],
};

describe("LiveActivities", () => {
  it.effect("keeps the arming time when the current card re-registers its token", () => {
    const armedAt = "2026-05-25T00:00:00.000Z";
    const insertedValues: Array<Record<string, unknown>> = [];
    const conflictSets: Array<Record<string, unknown> | undefined> = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Effect.succeed([{ activityPushToken: "current-token", remoteStartedAt: armedAt }]),
        }),
      }),
      update: () => ({ set: () => ({ where: () => Effect.void }) }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedValues.push(values);
          return {
            onConflictDoUpdate: (config: { readonly set?: Record<string, unknown> }) => {
              conflictSets.push(config.set);
              return Effect.void;
            },
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];
    const register = (activityPushToken: string) =>
      Effect.flatMap(LiveActivities.LiveActivities, (liveActivities) =>
        liveActivities.register({
          userId: "user-1",
          registration: {
            deviceId: "device-1" as RelayLiveActivityRegistrationRequest["deviceId"],
            activityPushToken:
              activityPushToken as RelayLiveActivityRegistrationRequest["activityPushToken"],
          },
        }),
      );

    return Effect.gen(function* () {
      yield* register("current-token");
      yield* register("new-card-token");

      expect(insertedValues[0]).toMatchObject({ remoteStartedAt: armedAt });
      expect(conflictSets[0]).toMatchObject({ remoteStartedAt: armedAt, lastAggregateJson: null });
      expect(insertedValues[1]?.remoteStartedAt).not.toBe(armedAt);
      expect(conflictSets[1]?.remoteStartedAt).not.toBe(armedAt);
    }).pipe(
      Effect.provide(
        LiveActivities.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });

  it.effect("preserves ended state when a delayed update delivery is marked", () => {
    const insertedValues: Array<Record<string, unknown>> = [];
    const conflictConfigs: Array<{
      readonly set?: Record<string, unknown>;
    }> = [];

    const fakeDb = {
      insert: (table: unknown) => {
        expect(table).toBe(relayLiveActivities);
        return {
          values: (values: Record<string, unknown>) => {
            insertedValues.push(values);
            return {
              onConflictDoUpdate: (config: { readonly set?: Record<string, unknown> }) => {
                conflictConfigs.push(config);
                return Effect.void;
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const liveActivities = yield* LiveActivities.LiveActivities;
      yield* liveActivities.markDelivery({
        userId: "user-2",
        deviceId: "device-1",
        kind: "live_activity_update",
        aggregate,
        deliveredAt: "2026-05-25T00:00:10.000Z",
      });

      expect(insertedValues).toEqual([
        expect.objectContaining({
          userId: "user-2",
          deviceId: "device-1",
          endedAt: null,
        }),
      ]);
      expect(conflictConfigs[0]?.set).toEqual(
        expect.objectContaining({
          endedAt: relayLiveActivities.endedAt,
          lastLiveActivityDeliveryAt: "2026-05-25T00:00:10.000Z",
        }),
      );
    }).pipe(
      Effect.provide(
        LiveActivities.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });

  it.effect("clears the aggregate of activities that ended over an hour ago and stayed ended", () =>
    Effect.gen(function* () {
      const now = Date.parse("2026-06-01T00:00:00.000Z");
      yield* TestClock.setTime(now);
      const minutesAgo = (minutes: number) =>
        DateTime.formatIso(DateTime.makeUnsafe(now - minutes * 60_000));
      const { db, layer } = yield* makePgliteRelayDb;
      const activity = (deviceId: string, endedAt: string, lastDeliveryAt: string) => ({
        userId: "user-1",
        deviceId,
        endedAt,
        lastAggregateJson: aggregate,
        lastLiveActivityDeliveryAt: lastDeliveryAt,
        createdAt: minutesAgo(600),
        updatedAt: lastDeliveryAt,
      });
      yield* Effect.promise(() =>
        db.insert(relayLiveActivities).values([
          activity("ended", minutesAgo(61), minutesAgo(61)),
          activity("recently-ended", minutesAgo(59), minutesAgo(59)),
          // Android keeps an old endedAt while later updates show the card again.
          activity("updated-after-end", minutesAgo(180), minutesAgo(120)),
        ]),
      );
      const liveActivities = yield* Effect.service(LiveActivities.LiveActivities).pipe(
        Effect.provide(LiveActivities.layer.pipe(Layer.provide(layer))),
      );

      yield* liveActivities.clearEndedAggregates;
      const rows = yield* Effect.promise(() => db.select().from(relayLiveActivities));
      expect(
        rows
          .filter((row) => row.lastAggregateJson !== null)
          .map((row) => row.deviceId)
          .toSorted(),
      ).toEqual(["recently-ended", "updated-after-end"]);
    }),
  );

  it.effect("rejects a Live Activity for a device the relay no longer has", () =>
    Effect.gen(function* () {
      const { db, layer } = yield* makePgliteRelayDb;
      const liveActivities = yield* Effect.service(LiveActivities.LiveActivities).pipe(
        Effect.provide(LiveActivities.layer.pipe(Layer.provide(layer))),
      );

      const error = yield* liveActivities
        .register({
          userId: "user-1",
          registration: {
            deviceId: "pruned" as RelayLiveActivityRegistrationRequest["deviceId"],
            activityPushToken:
              "activity-token" as RelayLiveActivityRegistrationRequest["activityPushToken"],
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("LiveActivityDeviceNotRegisteredError");
      expect(yield* Effect.promise(() => db.select().from(relayLiveActivities))).toEqual([]);
    }),
  );
});
