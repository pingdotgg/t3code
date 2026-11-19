import * as NodeServices from "@effect/platform-node/NodeServices";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks, relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";

describe("EnvironmentLinks", () => {
  it.effect("carries the webhook-hold opt-in over only from links with the same key", () => {
    const inserted: Array<Record<string, unknown>> = [];
    const revoked: Array<{ values: Record<string, unknown>; condition: unknown }> = [];
    const fakeDb = {
      $client: { withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect },
      select: () => ({ from: () => ({ where: () => ({ for: () => Effect.succeed([]) }) }) }),
      execute: () => Effect.void,
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: unknown) =>
            Effect.sync(() => {
              revoked.push({ values, condition });
            }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return {
            onConflictDoNothing: () => ({ returning: () => Effect.succeed([{}]) }),
            onConflictDoUpdate: () => Effect.void,
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      yield* links.upsert({
        userId: "user-1",
        request: {
          notificationsEnabled: false,
          liveActivitiesEnabled: false,
          managedTunnelsEnabled: true,
        } as never,
        proof: {
          environmentId: "env-1",
          environmentPublicKey: "public-key-1",
          descriptor: { label: "Laptop" },
        } as never,
        endpoint: { httpBaseUrl: "https://a.example", wsBaseUrl: "wss://a.example" } as never,
      });
      const query = new PgDialect().sqlToQuery(inserted[0]?.holdWebhooksWhileOffline as never);
      expect(query.sql).toContain("environment_public_key");
      expect(query.params).toEqual(["env-1", "public-key-1"]);
      expect(revoked).toHaveLength(1);
      expect(revoked[0]?.values.revokedAt).toEqual(inserted[0]?.updatedAt);
      const priorLinks = new PgDialect().sqlToQuery(revoked[0]?.condition as never);
      expect(priorLinks.sql).toContain('"user_id" <>');
      expect(priorLinks.sql).toContain('"revoked_at" is null');
      expect(priorLinks.params).toEqual(["env-1", "public-key-1", "user-1"]);
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });

  interface LinkRow {
    readonly environmentPublicKey: string;
    readonly endpointProviderKind: string;
    readonly revokedAt: string | null;
  }
  const tunnelLink: LinkRow = {
    environmentPublicKey: "public-key-1",
    endpointProviderKind: "cloudflare_tunnel",
    revokedAt: null,
  };
  it.effect.each<{
    readonly when: string;
    readonly previous?: LinkRow;
    // The link a concurrent first link inserted after this lock read found none.
    readonly raced?: LinkRow;
    readonly providerKind?: string;
    readonly moved: boolean;
  }>([
    { when: "a first link", moved: true },
    {
      when: "a concurrent first link",
      raced: { ...tunnelLink, environmentPublicKey: "public-key-0" },
      moved: true,
    },
    {
      when: "a replaced key",
      previous: { ...tunnelLink, environmentPublicKey: "public-key-0" },
      moved: true,
    },
    {
      when: "a revoked link",
      previous: { ...tunnelLink, revokedAt: "2026-06-01T00:00:00.000Z" },
      moved: true,
    },
    {
      when: "a publish-only link",
      previous: { ...tunnelLink, endpointProviderKind: "manual" },
      moved: true,
    },
    { when: "an unchanged tunnel link", previous: tunnelLink, moved: false },
    {
      when: "a relink to publish-only",
      previous: { ...tunnelLink, environmentPublicKey: "public-key-0" },
      providerKind: "manual",
      moved: false,
    },
  ])(
    "moves the allocation generation only when a link makes recovery usable again ($when)",
    ({ previous, raced, providerKind = "cloudflare_tunnel", moved }) => {
      const events: Array<string> = [];
      const locks: Array<unknown> = [];
      const allocationUpdates: Array<{
        readonly set: Record<string, unknown>;
        readonly where: unknown;
      }> = [];
      const fakeDb = {
        $client: {
          withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.sync(() => events.push("begin")).pipe(
              Effect.andThen(effect),
              Effect.tap(() => Effect.sync(() => events.push("commit"))),
            ),
        },
        select: () => ({
          from: (table: unknown) => {
            expect(table).toBe(relayEnvironmentLinks);
            return {
              where: (where: unknown) => ({
                for: (strength: string) =>
                  Effect.sync(() => {
                    expect(strength).toBe("update");
                    events.push("lock");
                    locks.push(where);
                    const row = locks.length === 1 ? previous : raced;
                    return row === undefined ? [] : [row];
                  }),
              }),
            };
          },
        }),
        execute: () => Effect.sync(() => events.push("advisory-lock")),
        update: (table: unknown) => {
          if (table === relayEnvironmentLinks) {
            return { set: () => ({ where: () => Effect.sync(() => events.push("revoke")) }) };
          }
          expect(table).toBe(relayManagedEndpointAllocations);
          return {
            set: (set: Record<string, unknown>) => ({
              where: (where: unknown) =>
                Effect.sync(() => {
                  events.push("allocation");
                  allocationUpdates.push({ set, where });
                }),
            }),
          };
        },
        insert: (table: unknown) => {
          expect(table).toBe(relayEnvironmentLinks);
          return {
            values: () => ({
              onConflictDoNothing: () => ({
                returning: () =>
                  Effect.sync(() => {
                    events.push("insert");
                    return raced === undefined ? [{ environmentId: "env-1" }] : [];
                  }),
              }),
              onConflictDoUpdate: () => Effect.sync(() => events.push("link")),
            }),
          };
        },
      } as unknown as RelayDb.RelayDb["Service"];

      return Effect.gen(function* () {
        const links = yield* EnvironmentLinks.EnvironmentLinks;
        yield* links.upsert({
          userId: "user-1",
          request: {
            notificationsEnabled: false,
            liveActivitiesEnabled: false,
            managedTunnelsEnabled: providerKind === "cloudflare_tunnel",
          } as never,
          proof: {
            environmentId: "env-1",
            environmentPublicKey: "public-key-1",
            descriptor: { label: "Laptop" },
          } as never,
          endpoint: {
            httpBaseUrl: "https://a.example",
            wsBaseUrl: "wss://a.example",
            providerKind,
          } as never,
        });

        expect(events).toEqual([
          "begin",
          "advisory-lock",
          "lock",
          ...(previous === undefined ? ["insert"] : []),
          ...(raced === undefined ? [] : ["lock"]),
          ...(previous === undefined && raced === undefined ? [] : ["link"]),
          "revoke",
          ...(moved ? ["allocation"] : []),
          "commit",
        ]);
        const dialect = new PgDialect();
        expect(dialect.sqlToQuery(locks[0] as never).params).toEqual(["user-1", "env-1"]);
        for (const { set, where } of allocationUpdates) {
          const query = dialect.sqlToQuery(where as never);
          expect(query.sql).toContain('"recovery_environment_public_key" = $3');
          expect(query.params).toEqual(["user-1", "env-1", "public-key-1"]);
          expect(dialect.sqlToQuery(set.generation as never).sql).toContain('"generation" + 1');
        }
      }).pipe(
        Effect.provide(
          EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
        ),
      );
    },
  );

  it.effect("updates Live Activities only on the matching active link", () =>
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
      const matching = { userId: "user-1", environmentId: "env-1", environmentPublicKey: "key-1" };
      const revoked = { ...matching, environmentId: "revoked-env" };
      const timestamp = "2026-01-01T00:00:00.000Z";
      const rows = [
        matching,
        { ...matching, userId: "user-2" },
        { ...matching, environmentId: "env-2" },
        { ...matching, userId: "user-3", environmentPublicKey: "key-2" },
        { ...revoked, revokedAt: timestamp },
      ];
      yield* Effect.promise(() =>
        db.insert(relayEnvironmentLinks).values(
          rows.map((row) => ({
            ...row,
            endpointHttpBaseUrl: "https://environment.test",
            endpointWsBaseUrl: "wss://environment.test",
            endpointProviderKind: "cloudflare_tunnel",
            createdAt: timestamp,
            updatedAt: timestamp,
          })),
        ),
      );
      // PGlite returns promises where the production Drizzle driver returns Effects.
      const effectDb = {
        update: (table: typeof relayEnvironmentLinks) => ({
          set: (values: Partial<typeof relayEnvironmentLinks.$inferInsert>) => ({
            where: (condition: SQL | undefined) => ({
              returning: (fields: { environmentId: typeof relayEnvironmentLinks.environmentId }) =>
                Effect.promise(() =>
                  db.update(table).set(values).where(condition).returning(fields),
                ),
            }),
          }),
        }),
      } as unknown as RelayDb.RelayDb["Service"];
      const links = yield* Effect.service(EnvironmentLinks.EnvironmentLinks).pipe(
        Effect.provide(
          EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, effectDb))),
        ),
      );
      expect(
        yield* links.updateLiveActivityPreference({ ...matching, liveActivitiesEnabled: false }),
      ).toBe(true);
      expect(
        yield* links.updateLiveActivityPreference({
          ...matching,
          environmentPublicKey: "key-2",
          liveActivitiesEnabled: false,
        }),
      ).toBe(false);
      expect(
        yield* links.updateLiveActivityPreference({ ...revoked, liveActivitiesEnabled: false }),
      ).toBe(false);

      const updated = yield* Effect.promise(() => db.select().from(relayEnvironmentLinks));
      expect(
        updated
          .filter((row) => !row.liveActivitiesEnabled)
          .map(({ userId, environmentId }) => ({
            userId,
            environmentId,
          })),
      ).toEqual([{ userId: matching.userId, environmentId: matching.environmentId }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("revokes only the active link owned by the requesting user", () => {
    const updateValues: Array<Record<string, unknown>> = [];
    const whereConditions: Array<unknown> = [];
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayEnvironmentLinks);
        return {
          set: (values: Record<string, unknown>) => {
            updateValues.push(values);
            return {
              where: (condition: unknown) => {
                whereConditions.push(condition);
                return {
                  returning: () => {
                    return Effect.succeed([{ environmentId: "env-1" }]);
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const revoked = yield* links.revokeForUser({
        userId: "user-1",
        environmentId: "env-1",
      });

      expect(revoked).toBe(true);
      expect(updateValues).toHaveLength(1);
      expect(updateValues[0]?.revokedAt).toEqual(updateValues[0]?.updatedAt);
      expect(typeof updateValues[0]?.revokedAt).toBe("string");
      expect(whereConditions).toHaveLength(1);

      const dialect = new PgDialect();
      const query = dialect.sqlToQuery(whereConditions[0] as never);
      expect(query.sql).toContain('"relay_environment_links"."user_id" = $1');
      expect(query.sql).toContain('"relay_environment_links"."environment_id" = $2');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
      expect(query.params).toEqual(["user-1", "env-1"]);
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });
});
