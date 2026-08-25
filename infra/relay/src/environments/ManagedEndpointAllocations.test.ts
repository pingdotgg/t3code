import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { PgDialect } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  ManagedEndpointAllocations.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));

describe("ManagedEndpointAllocations", () => {
  it.effect("clears endpoint readiness only when the recorded tunnel changes", () => {
    let updated:
      | {
          readonly tunnelId: string;
          readonly readyAt: unknown;
        }
      | undefined;
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          set: (values: { readonly tunnelId: string; readonly readyAt: unknown }) => {
            updated = values;
            return {
              where: () => ({
                returning: () => Effect.succeed([{ generation: 8 }]),
              }),
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(
        yield* allocations.recordTunnel({
          userId: "user-1",
          environmentId: "environment-1",
          tunnelId: "replacement-tunnel",
          generation: 7,
        }),
      ).toBe(8);
      expect(updated?.tunnelId).toBe("replacement-tunnel");
      const query = new PgDialect().sqlToQuery(updated?.readyAt as never);
      expect(query.sql).toBe(
        'case when "relay_managed_endpoint_allocations"."tunnel_id" = $1 then "relay_managed_endpoint_allocations"."ready_at" else null end',
      );
      expect(query.params).toEqual(["replacement-tunnel"]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("records recovery support and advances the allocation generation", () => {
    let updated:
      | {
          readonly recoveryEnabledAt: string;
          readonly recoveryEnvironmentPublicKey: string;
          readonly updatedAt: string;
        }
      | undefined;
    let condition: unknown;
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          set: (values: {
            readonly recoveryEnabledAt: string;
            readonly recoveryEnvironmentPublicKey: string;
            readonly updatedAt: string;
          }) => {
            updated = values;
            return {
              where: (where: unknown) => {
                condition = where;
                return {
                  returning: () => Effect.succeed([{ environmentId: "environment-1" }]),
                };
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(
        yield* allocations.enableRecovery({
          userId: "user-1",
          environmentId: "environment-1",
          tunnelId: "tunnel-1",
          environmentPublicKey: "public-key",
        }),
      ).toBe(true);

      expect(updated?.recoveryEnabledAt).toBe(updated?.updatedAt);
      expect(updated?.recoveryEnabledAt).toBeDefined();
      expect(updated?.recoveryEnvironmentPublicKey).toBe("public-key");
      const query = new PgDialect().sqlToQuery(condition as never);
      expect(query.sql).toContain('"relay_managed_endpoint_allocations"."tunnel_id"');
      expect(query.sql).toContain('"relay_environment_links"."environment_public_key"');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
      expect(query.sql).toContain("for update");
      expect(query.params).toContain("tunnel-1");
      expect(query.params).toContain("public-key");
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("rejects recovery when the tunnel or active link no longer matches", () => {
    const fakeDb = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Effect.succeed([]),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(
        yield* allocations.enableRecovery({
          userId: "user-1",
          environmentId: "environment-1",
          tunnelId: "missing-tunnel",
          environmentPublicKey: "public-key",
        }),
      ).toBe(false);
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
      generation: 1,
    };
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayManagedEndpointAllocations);
          return {
            leftJoin: () => ({
              where: () =>
                Effect.succeed([
                  {
                    ...base,
                    environmentId: "environment-1",
                    tunnelId: "tunnel-1",
                    recoveryEnabledAt: "2026-08-25T12:00:00.000Z",
                    recoveryEnvironmentPublicKey: "current-key",
                    linkedEnvironmentPublicKey: "current-key",
                  },
                  {
                    ...base,
                    environmentId: "environment-2",
                    tunnelId: "tunnel-2",
                    recoveryEnabledAt: null,
                    recoveryEnvironmentPublicKey: null,
                    linkedEnvironmentPublicKey: "current-key",
                  },
                  {
                    ...base,
                    environmentId: "environment-3",
                    tunnelId: "tunnel-3",
                    recoveryEnabledAt: "2026-08-25T12:00:00.000Z",
                    recoveryEnvironmentPublicKey: "old-key",
                    linkedEnvironmentPublicKey: "new-key",
                  },
                ]),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const result = yield* allocations.listByTunnelNames([
        "first-tunnel",
        "second-tunnel",
        "third-tunnel",
      ]);

      expect(result.map((entry) => [entry.tunnelId, entry.recoveryEnabled])).toEqual([
        ["tunnel-1", true],
        ["tunnel-2", false],
        ["tunnel-3", false],
      ]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("skips the database for an empty tunnel lookup", () =>
    Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(yield* allocations.listByTunnelNames([])).toEqual([]);
    }).pipe(Effect.provide(layerWithDb({} as RelayDb.RelayDb["Service"]))),
  );

  it.effect("splits large tunnel lookups into bounded database queries", () => {
    const batchSizes: number[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: (condition: unknown) => {
              batchSizes.push(new PgDialect().sqlToQuery(condition as never).params.length);
              return Effect.succeed([]);
            },
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const names = Array.from({ length: 1_001 }, (_, index) => `tunnel-${index}`);
      expect(yield* allocations.listByTunnelNames(names)).toEqual([]);
      expect(batchSizes).toEqual([500, 500, 1]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("returns a claim generation only when deprovision wins the allocation CAS", () => {
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          set: (_values: { readonly updatedAt: string }) => {
            return {
              where: () => ({
                returning: () => Effect.succeed([{ generation: 8 }]),
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
        generation: 7,
      });

      expect(generation).toBe(8);
      expect(generation).not.toBeNull();
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("holds the claimed allocation row while deleting its tunnel", () => {
    const operations: string[] = [];
    const fakeDb = {
      $client: {
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.sync(() => {
            operations.push("transaction");
          }).pipe(Effect.andThen(effect)),
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: (strength: string) =>
                Effect.sync(() => {
                  operations.push(`lock:${strength}`);
                  return [{ generation: 7 }];
                }),
            }),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const result = yield* allocations.withClaimedTunnel(
        {
          userId: "user-1",
          environmentId: "environment-1",
          tunnelId: "tunnel-1",
          generation: 7,
        },
        Effect.sync(() => {
          operations.push("delete");
          return true;
        }),
      );

      expect(Option.getOrNull(result)).toBe(true);
      expect(operations).toEqual(["transaction", "lock:update", "delete"]);
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
          generation: 7,
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
