import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayDeliveryAttempts } from "../persistence/schema.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";

describe("DeliveryAttempts", () => {
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

  it.effect("prunes delivery attempts last written before the cutoff", () => {
    const deletes: Array<{ readonly table: unknown; readonly where: SQL }> = [];
    const fakeDb = {
      delete: (table: unknown) => ({
        where: (where: SQL) => {
          deletes.push({ table, where });
          return Effect.void;
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      yield* attempts.prune({ createdBefore: "2026-05-12T00:00:00.000Z" });

      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.table).toBe(relayDeliveryAttempts);
      expect(new PgDialect().sqlToQuery(deletes[0]!.where)).toEqual({
        sql: '"relay_delivery_attempts"."created_at" < $1',
        params: ["2026-05-12T00:00:00.000Z"],
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
