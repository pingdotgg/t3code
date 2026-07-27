import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import {
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  ManagedTunnelLimits.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));

function makeFakeDb(input: {
  readonly overrideRows?: Effect.Effect<ReadonlyArray<{ readonly maxTunnels: number }>, Error>;
  readonly countRows?: Effect.Effect<ReadonlyArray<{ readonly activeTunnels: number }>, Error>;
}) {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === relayManagedTunnelLimits) {
          return {
            where: () => ({
              limit: () => input.overrideRows ?? Effect.succeed([]),
            }),
          };
        }
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          where: () => input.countRows ?? Effect.succeed([{ activeTunnels: 0 }]),
        };
      },
    }),
  } as unknown as RelayDb.RelayDb["Service"];
}

describe("ManagedTunnelLimits", () => {
  it.effect("allows provisioning below the default limit", () => {
    const fakeDb = makeFakeDb({
      countRows: Effect.succeed([
        { activeTunnels: ManagedTunnelLimits.DEFAULT_MANAGED_TUNNEL_LIMIT - 1 },
      ]),
    });

    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      yield* limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("rejects provisioning at the default limit of 3", () => {
    const fakeDb = makeFakeDb({
      countRows: Effect.succeed([{ activeTunnels: 3 }]),
    });

    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitExceeded",
        userId: "user-1",
        environmentId: "environment-1",
        maxTunnels: 3,
        activeTunnels: 3,
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("honors a per-user override above the default", () => {
    const fakeDb = makeFakeDb({
      overrideRows: Effect.succeed([{ maxTunnels: 25 }]),
      countRows: Effect.succeed([{ activeTunnels: 10 }]),
    });

    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      yield* limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("honors a per-user override below the default", () => {
    const fakeDb = makeFakeDb({
      overrideRows: Effect.succeed([{ maxTunnels: 1 }]),
      countRows: Effect.succeed([{ activeTunnels: 1 }]),
    });

    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitExceeded",
        maxTunnels: 1,
        activeTunnels: 1,
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("retains database failures with operation and user identity", () => {
    const cause = new Error("database unavailable");
    const fakeDb = makeFakeDb({
      overrideRows: Effect.fail(cause),
    });

    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitPersistenceError",
        operation: "load-limit",
        userId: "user-1",
      });
      expect(error).toHaveProperty("cause", cause);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("retains count failures with operation and user identity", () => {
    const cause = new Error("database unavailable");
    const fakeDb = makeFakeDb({
      countRows: Effect.fail(cause),
    });

    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-1", environmentId: "environment-1" }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitPersistenceError",
        operation: "count-tunnels",
        userId: "user-1",
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });
});
