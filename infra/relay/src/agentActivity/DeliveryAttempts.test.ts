import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayDeliveryAttempts } from "../persistence/schema.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";

describe("DeliveryAttempts", () => {
  it.effect("records the signed queue source job id for APNs delivery auditability", () => {
    const insertedValues: Array<Record<string, unknown>> = [];
    const fakeDb = {
      insert: (table: unknown) => {
        expect(table).toBe(relayDeliveryAttempts);
        return {
          values: (values: Record<string, unknown>) => {
            insertedValues.push(values);
            return Effect.void;
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      yield* attempts.record({
        userId: "user-1",
        environmentId: "env-1",
        threadId: "thread-1",
        deviceId: "device-1",
        kind: "live_activity_update",
        sourceJobId: "job-1",
        token: "apns-token",
        apnsStatus: 200,
        apnsId: "apns-id",
      });

      expect(insertedValues).toHaveLength(1);
      expect(insertedValues[0]).toMatchObject({
        userId: "user-1",
        environmentId: "env-1",
        threadId: "thread-1",
        deviceId: "device-1",
        kind: "live_activity_update",
        sourceJobId: "job-1",
        tokenSuffix: "ns-token",
        apnsStatus: 200,
        apnsId: "apns-id",
      });
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("claims signed queue source jobs before APNs delivery", () => {
    const insertedValues: Array<Record<string, unknown>> = [];
    const conflictTargets: Array<unknown> = [];
    const fakeDb = {
      insert: (table: unknown) => {
        expect(table).toBe(relayDeliveryAttempts);
        return {
          values: (values: Record<string, unknown>) => {
            insertedValues.push(values);
            return {
              onConflictDoNothing: (config: { readonly target: unknown }) => {
                conflictTargets.push(config.target);
                return {
                  returning: () => Effect.succeed([{ id: values.id }]),
                };
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const claimed = yield* attempts.claimSourceJob({
        userId: "user-1",
        environmentId: "env-1",
        threadId: "thread-1",
        deviceId: "device-1",
        kind: "push_notification",
        sourceJobId: "job-1",
        token: "apns-token",
      });

      expect(claimed).toBe("claimed");
      expect(conflictTargets).toEqual([relayDeliveryAttempts.sourceJobId]);
      expect(insertedValues[0]).toMatchObject({
        kind: "push_notification",
        sourceJobId: "job-1",
        tokenSuffix: "ns-token",
        apnsStatus: null,
      });
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("reports completed source jobs when the durable claim already exists", () => {
    const fakeDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Effect.succeed([]),
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Effect.succeed([
                {
                  createdAt: "2026-05-26T00:00:00.000Z",
                  apnsStatus: 200,
                  apnsReason: null,
                  apnsId: null,
                  transportError: null,
                },
              ]),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const claimed = yield* attempts.claimSourceJob({
        userId: "user-1",
        environmentId: null,
        threadId: null,
        deviceId: "device-1",
        kind: "live_activity_update",
        sourceJobId: "job-1",
        token: "apns-token",
      });

      expect(claimed).toBe("completed");
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("reports in-flight source jobs while an active claim lease exists", () => {
    const fakeDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Effect.succeed([]),
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Effect.succeed([
                {
                  createdAt: "2999-01-01T00:00:00.000Z",
                  apnsStatus: null,
                  apnsReason: null,
                  apnsId: null,
                  transportError: null,
                },
              ]),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const claimed = yield* attempts.claimSourceJob({
        userId: "user-1",
        environmentId: null,
        threadId: null,
        deviceId: "device-1",
        kind: "live_activity_update",
        sourceJobId: "job-1",
        token: "apns-token",
      });

      expect(claimed).toBe("in_flight");
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("reclaims source jobs after the claim lease expires", () => {
    const updatedValues: Array<Record<string, unknown>> = [];
    const fakeDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Effect.succeed([]),
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Effect.succeed([
                {
                  createdAt: "1969-12-31T23:00:00.000Z",
                  apnsStatus: null,
                  apnsReason: null,
                  apnsId: null,
                  transportError: null,
                },
              ]),
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: () => ({
              returning: () => Effect.succeed([{ id: "attempt-1" }]),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const claimed = yield* attempts.claimSourceJob({
        userId: "user-1",
        environmentId: null,
        threadId: null,
        deviceId: "device-1",
        kind: "live_activity_update",
        sourceJobId: "job-1",
        token: "apns-token",
      });

      expect(claimed).toBe("claimed");
      expect(updatedValues[0]?.createdAt).toEqual(expect.any(String));
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("completes a claimed source job with the APNs outcome", () => {
    const updatedValues: Array<Record<string, unknown>> = [];
    const whereClauses: Array<unknown> = [];
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayDeliveryAttempts);
        return {
          set: (values: Record<string, unknown>) => {
            updatedValues.push(values);
            return {
              where: (clause: unknown) => {
                whereClauses.push(clause);
                return Effect.void;
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      yield* attempts.completeSourceJob({
        sourceJobId: "job-1",
        apnsStatus: 410,
        apnsReason: "Unregistered",
        apnsId: "apns-id",
      });

      expect(whereClauses).toHaveLength(1);
      expect(updatedValues).toEqual([
        {
          createdAt: expect.any(String),
          apnsStatus: 410,
          apnsReason: "Unregistered",
          apnsId: "apns-id",
          transportError: null,
        },
      ]);
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("preserves operation context and causes for persistence failures", () => {
    const cause = new Error("database unavailable");
    const fakeDb = {
      insert: () => ({
        values: (values: Record<string, unknown>) =>
          values.kind === "record"
            ? Effect.fail(cause)
            : {
                onConflictDoNothing: () => ({
                  returning: () => Effect.fail(cause),
                }),
              },
      }),
      update: () => ({
        set: () => ({
          where: () => Effect.fail(cause),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const recordError = yield* Effect.flip(
        attempts.record({
          userId: "user-1",
          environmentId: "env-1",
          threadId: "thread-1",
          deviceId: "device-1",
          kind: "record",
          sourceJobId: "job-1",
          token: "apns-token",
        }),
      );
      const claimError = yield* Effect.flip(
        attempts.claimSourceJob({
          userId: "user-2",
          environmentId: "env-2",
          threadId: "thread-2",
          deviceId: "device-2",
          kind: "claim",
          sourceJobId: "job-2",
          token: "apns-token",
        }),
      );
      const completionError = yield* Effect.flip(
        attempts.completeSourceJob({ sourceJobId: "job-3", apnsStatus: 500 }),
      );

      expect(recordError).toMatchObject({
        operation: "record",
        sourceJobId: "job-1",
        userId: "user-1",
        environmentId: "env-1",
        threadId: "thread-1",
        deviceId: "device-1",
        kind: "record",
        cause,
        message: "Failed to persist APNs delivery attempt during record.",
      });
      expect(claimError).toMatchObject({
        operation: "claim-source-job",
        sourceJobId: "job-2",
        userId: "user-2",
        environmentId: "env-2",
        threadId: "thread-2",
        deviceId: "device-2",
        kind: "claim",
        cause,
        message: "Failed to persist APNs delivery attempt during claim-source-job.",
      });
      expect(completionError).toMatchObject({
        operation: "complete-source-job",
        sourceJobId: "job-3",
        userId: null,
        environmentId: null,
        threadId: null,
        deviceId: null,
        kind: null,
        cause,
        message: "Failed to persist APNs delivery attempt during complete-source-job.",
      });
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });
});
