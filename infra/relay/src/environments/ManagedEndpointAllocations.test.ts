import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  ManagedEndpointAllocations.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));

describe("ManagedEndpointAllocations", () => {
  it.effect("records recovery support and advances the allocation generation", () => {
    let updated:
      | {
          readonly recoveryEnabledAt: string;
          readonly updatedAt: string;
        }
      | undefined;
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          set: (values: { readonly recoveryEnabledAt: string; readonly updatedAt: string }) => {
            updated = values;
            return {
              where: () => Effect.void,
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      yield* allocations.enableRecovery({
        userId: "user-1",
        environmentId: "environment-1",
      });

      expect(updated?.recoveryEnabledAt).toBe(updated?.updatedAt);
      expect(updated?.recoveryEnabledAt).toBeDefined();
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("returns recovery support with tunnel allocation lookups", () => {
    const base = {
      userId: "user-1",
      hostname: "environment.example.test",
      tunnelName: "managed-tunnel",
      dnsRecordId: "dns-1",
      readyAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    };
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayManagedEndpointAllocations);
          return {
            where: () =>
              Effect.succeed([
                {
                  ...base,
                  environmentId: "environment-1",
                  tunnelId: "tunnel-1",
                  recoveryEnabledAt: "2026-08-25T12:00:00.000Z",
                },
                {
                  ...base,
                  environmentId: "environment-2",
                  tunnelId: "tunnel-2",
                  recoveryEnabledAt: null,
                },
              ]),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const result = yield* allocations.listByTunnelNames(["first-tunnel", "second-tunnel"]);

      expect(result.map((entry) => [entry.tunnelId, entry.recoveryEnabled])).toEqual([
        ["tunnel-1", true],
        ["tunnel-2", false],
      ]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("skips the database for an empty tunnel lookup", () =>
    Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(yield* allocations.listByTunnelNames([])).toEqual([]);
    }).pipe(Effect.provide(layerWithDb({} as RelayDb.RelayDb["Service"]))),
  );

  it.effect("returns a claim generation only when deprovision wins the allocation CAS", () => {
    let claimedAt: string | undefined;
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          set: (values: { readonly updatedAt: string }) => {
            claimedAt = values.updatedAt;
            return {
              where: () => ({
                returning: () => Effect.succeed([{ userId: "user-1" }]),
              }),
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const generation = yield* allocations.claimDeprovision({
        userId: "user-1",
        environmentId: "environment-1",
        updatedAt: "captured-generation",
      });

      expect(generation).toBe(claimedAt);
      expect(generation).not.toBeNull();
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("does not remove an allocation superseded after a deprovision claim", () => {
    const fakeDb = {
      delete: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          where: () => ({
            returning: () => Effect.succeed([]),
          }),
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(
        yield* allocations.removeClaimed({
          userId: "user-1",
          environmentId: "environment-1",
          updatedAt: "outdated-claim-generation",
        }),
      ).toBe(false);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("retains database failures with allocation operation and identity", () => {
    const cause = new Error("database unavailable");
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayManagedEndpointAllocations);
          return {
            where: () => ({
              limit: () => Effect.fail(cause),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const error = yield* Effect.flip(
        allocations.get({ userId: "user-1", environmentId: "environment-1" }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedEndpointAllocationPersistenceError",
        operation: "get",
        stage: "database-request",
        userId: "user-1",
        environmentId: "environment-1",
      });
      expect(error.cause).toBe(cause);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("reports an unresolved reservation without manufacturing a cause", () => {
    const fakeDb = {
      insert: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          values: () => ({
            onConflictDoNothing: () => ({
              returning: () => Effect.succeed([]),
            }),
          }),
        };
      },
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayManagedEndpointAllocations);
          return {
            where: () => ({
              limit: () => Effect.succeed([]),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const error = yield* Effect.flip(
        allocations.reserve({
          userId: "user-1",
          environmentId: "environment-1",
          hostname: "environment-1.example.test",
          tunnelName: "environment-1-tunnel",
        }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedEndpointAllocationPersistenceError",
        operation: "reserve",
        stage: "resolve-reservation",
        userId: "user-1",
        environmentId: "environment-1",
        hostname: "environment-1.example.test",
        tunnelName: "environment-1-tunnel",
      });
      expect(error.cause).toBeUndefined();
      expect(error.message).toContain("'resolve-reservation'");
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });
});
