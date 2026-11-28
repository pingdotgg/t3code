import type {
  RelayAgentActivityAggregateState,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
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
});
