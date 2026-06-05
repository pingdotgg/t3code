import type {
  RelayAgentActivityAggregateState,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayDb, type RelayDatabase } from "../db.ts";
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
  it.effect(
    "claims Live Activity push tokens globally before upserting the current user device",
    () => {
      const registration: RelayLiveActivityRegistrationRequest = {
        deviceId: "device-1" as RelayLiveActivityRegistrationRequest["deviceId"],
        activityPushToken:
          "activity-push-token" as RelayLiveActivityRegistrationRequest["activityPushToken"],
      };
      const calls: Array<string> = [];
      const updateSets: Array<Record<string, unknown>> = [];
      const updateConditions: Array<SQL> = [];
      const insertedValues: Array<Record<string, unknown>> = [];
      const conflictConfigs: Array<{
        readonly set?: Record<string, unknown>;
      }> = [];
      const dialect = new PgDialect();

      const fakeDb = {
        update: (table: unknown) => {
          expect(table).toBe(relayLiveActivities);
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
          expect(table).toBe(relayLiveActivities);
          calls.push("insert");
          return {
            values: (values: Record<string, unknown>) => {
              insertedValues.push(values);
              calls.push("insert.values");
              return {
                onConflictDoUpdate: (config: { readonly set?: Record<string, unknown> }) => {
                  expect(config).toBeDefined();
                  conflictConfigs.push(config);
                  calls.push("insert.onConflictDoUpdate");
                  return Effect.void;
                },
              };
            },
          };
        },
      } as unknown as RelayDatabase;

      return Effect.gen(function* () {
        const liveActivities = yield* LiveActivities.LiveActivities;
        yield* liveActivities.register({ userId: "user-2", registration });

        expect(calls).toEqual([
          "update",
          "update.set",
          "update.where",
          "insert",
          "insert.values",
          "insert.onConflictDoUpdate",
        ]);
        expect(updateSets).toEqual([
          expect.objectContaining({
            activityPushToken: null,
            remoteStartQueuedAt: null,
            remoteStartedAt: null,
          }),
        ]);
        expect(updateConditions.map((condition) => dialect.sqlToQuery(condition))).toEqual([
          {
            sql: '"relay_live_activities"."activity_push_token" = $1',
            params: ["activity-push-token"],
          },
        ]);
        expect(insertedValues).toEqual([
          expect.objectContaining({
            userId: "user-2",
            deviceId: "device-1",
            activityPushToken: "activity-push-token",
            remoteStartQueuedAt: null,
            remoteStartedAt: expect.any(String),
            endedAt: null,
            lastAggregateJson: null,
            lastLiveActivityDeliveryAt: null,
          }),
        ]);
        expect(conflictConfigs[0]?.set).toEqual(
          expect.objectContaining({
            activityPushToken: "activity-push-token",
            remoteStartQueuedAt: null,
            remoteStartedAt: expect.any(String),
            endedAt: null,
            lastAggregateJson: null,
            lastLiveActivityDeliveryAt: null,
          }),
        );
      }).pipe(
        Effect.provide(LiveActivities.layer.pipe(Layer.provide(Layer.succeed(RelayDb, fakeDb)))),
      );
    },
  );

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
    } as unknown as RelayDatabase;

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
      Effect.provide(LiveActivities.layer.pipe(Layer.provide(Layer.succeed(RelayDb, fakeDb)))),
    );
  });
});
