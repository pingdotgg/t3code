import type {
  RelayAgentActivityAggregateState,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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
      } as unknown as RelayDb.RelayDb["Service"];

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
        Effect.provide(
          LiveActivities.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
        ),
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

  it.effect("retires the previous activity token when a start or end is delivered", () => {
    const conflictConfigs: Array<{ readonly set?: Record<string, unknown> }> = [];
    const fakeDb = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: (config: { readonly set?: Record<string, unknown> }) => {
            conflictConfigs.push(config);
            return Effect.void;
          },
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const liveActivities = yield* LiveActivities.LiveActivities;
      const mark = (kind: "live_activity_start" | "live_activity_update" | "live_activity_end") =>
        liveActivities.markDelivery({
          userId: "user-2",
          deviceId: "device-1",
          kind,
          aggregate,
          deliveredAt: "2026-05-25T00:00:10.000Z",
        });
      yield* mark("live_activity_start");
      yield* mark("live_activity_update");
      yield* mark("live_activity_end");

      // A start begins a new activity generation and an end retires the
      // current one; both must drop the stored update token so later
      // deliveries can't route to the dead activity. Plain updates keep it.
      expect(conflictConfigs[0]?.set).toEqual(
        expect.objectContaining({
          activityPushToken: null,
          remoteStartedAt: "2026-05-25T00:00:10.000Z",
          endedAt: null,
        }),
      );
      expect(conflictConfigs[1]?.set?.activityPushToken).not.toBeNull();
      expect(conflictConfigs[2]?.set).toEqual(
        expect.objectContaining({
          activityPushToken: null,
          endedAt: "2026-05-25T00:00:10.000Z",
        }),
      );
    }).pipe(
      Effect.provide(
        LiveActivities.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });

  it.effect("preserves correlation context and causes for persistence failures", () => {
    const cause = new Error("database unavailable");
    const registration: RelayLiveActivityRegistrationRequest = {
      deviceId: "device-1" as RelayLiveActivityRegistrationRequest["deviceId"],
      activityPushToken:
        "activity-push-token" as RelayLiveActivityRegistrationRequest["activityPushToken"],
    };
    const fakeDb = {
      update: () => ({
        set: () => ({ where: () => Effect.fail(cause) }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoUpdate: () => Effect.fail(cause) }),
      }),
      select: () => ({
        from: () => ({
          leftJoin: () => ({ where: () => Effect.fail(cause) }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const liveActivities = yield* LiveActivities.LiveActivities;
      const registrationError = yield* Effect.flip(
        liveActivities.register({ userId: "user-1", registration }),
      );
      const targetListError = yield* Effect.flip(liveActivities.listTargets({ userId: "user-1" }));
      const deliveryErrors = yield* Effect.all(
        [
          liveActivities.markDelivery({
            userId: "user-1",
            deviceId: "device-1",
            kind: "live_activity_update",
            aggregate: null,
            deliveredAt: "2026-05-25T00:00:10.000Z",
          }),
          liveActivities.markStartQueued({
            userId: "user-1",
            deviceId: "device-1",
            queuedAt: "2026-05-25T00:00:10.000Z",
          }),
          liveActivities.clearStartQueued({ userId: "user-1", deviceId: "device-1" }),
          liveActivities.invalidateDeliveryToken({
            userId: "user-1",
            deviceId: "device-1",
            kind: "push_notification",
            invalidatedAt: "2026-05-25T00:00:10.000Z",
          }),
        ].map(Effect.flip),
        { concurrency: 1 },
      );

      expect(registrationError).toMatchObject({
        userId: "user-1",
        deviceId: "device-1",
        cause,
        message:
          "Failed to persist Live Activity registration for user user-1 and device device-1.",
      });
      expect(targetListError).toMatchObject({
        userId: "user-1",
        cause,
        message: "Failed to list Live Activity delivery targets for user user-1.",
      });

      const expectedDeliveryContext = [
        ["mark-delivery", "live_activity_update"],
        ["mark-start-queued", null],
        ["clear-start-queued", null],
        ["invalidate-delivery-token", "push_notification"],
      ] as const;
      for (const [index, [operation, kind]] of expectedDeliveryContext.entries()) {
        expect(deliveryErrors[index]).toMatchObject({
          operation,
          userId: "user-1",
          deviceId: "device-1",
          kind,
          cause,
          message: `Failed to persist Live Activity state during ${operation} for user user-1 and device device-1.`,
        });
      }
    }).pipe(
      Effect.provide(
        LiveActivities.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });
});
