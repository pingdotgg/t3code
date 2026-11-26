import * as NodeServices from "@effect/platform-node/NodeServices";
import { PGlite } from "@electric-sql/pglite";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks, relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  ManagedEndpointAllocations.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));

describe("ManagedEndpointAllocations", () => {
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

  it.effect("teardown claims leave updatedAt to provisioning writes", () => {
    // The tunnel limit compares link and allocation updatedAt; a claim that bumps it makes a
    // failed revoke cleanup look like a reprovision and keeps holding the user's slot.
    const writes: Array<Record<string, unknown>> = [];
    const fakeDb = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.push(values);
          return {
            where: () => ({ returning: () => Effect.succeed([{ generation: 2 }]) }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const key = { userId: "user-1", environmentId: "environment-1", generation: 1 };
      yield* allocations.claimDeprovision(key);
      yield* allocations.claimRelease({ ...key, tunnelId: "tunnel-1" });
      yield* allocations.claimRelease({ ...key, tunnelId: "tunnel-1", markReleased: true });

      expect(writes.map((values) => "updatedAt" in values)).toEqual([false, false, true]);
      expect(writes[2]?.["updatedAt"]).toBe(writes[2]?.["tunnelReleasedAt"]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("gates markReady and enableRecovery on matching generation and unreleased tunnel", () =>
    Effect.gen(function* () {
      const pg = yield* Effect.acquireRelease(
        Effect.promise(() => PGlite.create()),
        (client) => Effect.promise(() => client.close()),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* path.fromFileUrl(
        new URL("../../migrations/postgres/", import.meta.url),
      );
      for (const name of (yield* fs.readDirectory(migrationsDir)).toSorted()) {
        const migration = yield* fs.readFileString(`${migrationsDir}${name}/migration.sql`);
        yield* Effect.promise(() => pg.exec(migration));
      }

      const db = drizzle({ client: pg });
      const now = "2026-08-25T12:00:00.000Z";
      const origin = { localHttpHost: "127.0.0.1", localHttpPort: 3773 } as const;
      yield* Effect.promise(() =>
        db.insert(relayEnvironmentLinks).values({
          userId: "user-1",
          environmentId: "env-1",
          environmentPublicKey: "key-1",
          endpointHttpBaseUrl: "https://env-1.example.test/",
          endpointWsBaseUrl: "wss://env-1.example.test/ws",
          endpointProviderKind: "cloudflare_tunnel",
          managedTunnelsEnabled: true,
          createdAt: now,
          updatedAt: now,
        }),
      );
      yield* Effect.promise(() =>
        db.insert(relayManagedEndpointAllocations).values({
          userId: "user-1",
          environmentId: "env-1",
          hostname: "env-1.example.test",
          tunnelId: "tunnel-1",
          tunnelName: "tunnel-name-1",
          dnsRecordId: "dns-1",
          readyAt: now,
          origin,
          generation: 3,
          tunnelReleasedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      const effectDb = {
        update: (table: typeof relayManagedEndpointAllocations) => ({
          set: (values: Partial<typeof relayManagedEndpointAllocations.$inferInsert>) => ({
            where: (condition: SQL | undefined) => ({
              returning: (fields: Record<string, unknown>) =>
                Effect.promise(() =>
                  db
                    .update(table)
                    .set(values)
                    .where(condition)
                    .returning(fields as never),
                ),
            }),
          }),
        }),
      } as unknown as RelayDb.RelayDb["Service"];

      const allocations = yield* Effect.service(
        ManagedEndpointAllocations.ManagedEndpointAllocations,
      ).pipe(Effect.provide(layerWithDb(effectDb)));

      expect(
        yield* allocations.enableRecovery({
          userId: "user-1",
          environmentId: "env-1",
          tunnelId: "tunnel-1",
          environmentPublicKey: "key-1",
          origin,
          generation: 2,
        }),
      ).toBe(false);

      expect(
        yield* allocations.enableRecovery({
          userId: "user-1",
          environmentId: "env-1",
          tunnelId: "tunnel-1",
          environmentPublicKey: "key-1",
          origin,
          generation: 3,
        }),
      ).toBe(true);

      const readyGen = yield* allocations.markReady({
        userId: "user-1",
        environmentId: "env-1",
        tunnelId: "tunnel-1",
        generation: 4,
        origin,
      });
      expect(readyGen).toBe(5);

      const releasedGen = yield* allocations.claimRelease({
        userId: "user-1",
        environmentId: "env-1",
        tunnelId: "tunnel-1",
        generation: 5,
        markReleased: true,
      });
      expect(releasedGen).toBe(6);

      expect(
        yield* allocations.markReady({
          userId: "user-1",
          environmentId: "env-1",
          tunnelId: "tunnel-1",
          generation: 6,
          origin,
        }),
      ).toBeNull();
      expect(
        yield* allocations.enableRecovery({
          userId: "user-1",
          environmentId: "env-1",
          tunnelId: "tunnel-1",
          environmentPublicKey: "key-1",
          origin,
          generation: 6,
        }),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
