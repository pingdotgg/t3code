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
import { relayEnvironmentLinks } from "../persistence/schema.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";

describe("EnvironmentLinks", () => {
  it.effect("carries the webhook-hold opt-in over only from links with the same key", () => {
    const inserted: Array<Record<string, unknown>> = [];
    const conflictConfigs: Array<Record<string, unknown>> = [];
    const revoked: Array<{ values: Record<string, unknown>; condition: unknown }> = [];
    const fakeDb = {
      $client: {
        withTransaction: (effect: Effect.Effect<unknown>) => effect,
      },
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
            onConflictDoUpdate: (config: Record<string, unknown>) => {
              conflictConfigs.push(config);
              return {
                returning: () => Effect.succeed([{ environmentId: "env-1" }]),
              };
            },
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const upserted = yield* links.upsert({
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
      expect(upserted).toBe(true);
      const setWhere = new PgDialect().sqlToQuery(conflictConfigs[0]?.setWhere as never);
      expect(setWhere.sql).toContain('"revoked_at" is not null');
      expect(setWhere.sql).toContain('"environment_public_key" =');
      expect(setWhere.params).toEqual(["public-key-1"]);
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

  it.effect("refuses to overwrite an active link with a different environment public key", () =>
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
      const effectDb = {
        $client: {
          withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        },
        execute: (query: SQL) => Effect.promise(() => db.execute(query)),
        insert: (table: typeof relayEnvironmentLinks) => ({
          values: (values: typeof relayEnvironmentLinks.$inferInsert) => ({
            onConflictDoUpdate: (config: unknown) => ({
              returning: (fields: { environmentId: typeof relayEnvironmentLinks.environmentId }) =>
                Effect.promise(() =>
                  db
                    .insert(table)
                    .values(values)
                    .onConflictDoUpdate(config as never)
                    .returning(fields),
                ),
            }),
          }),
        }),
        update: (table: typeof relayEnvironmentLinks) => ({
          set: (values: Partial<typeof relayEnvironmentLinks.$inferInsert>) => ({
            where: (condition: SQL | undefined) => {
              const run = Effect.promise(() => db.update(table).set(values).where(condition));
              return Object.assign(run, {
                returning: (fields: {
                  environmentId: typeof relayEnvironmentLinks.environmentId;
                }) =>
                  Effect.promise(() =>
                    db.update(table).set(values).where(condition).returning(fields),
                  ),
              });
            },
          }),
        }),
      } as unknown as RelayDb.RelayDb["Service"];

      const links = yield* Effect.service(EnvironmentLinks.EnvironmentLinks).pipe(
        Effect.provide(
          EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, effectDb))),
        ),
      );
      const request = {
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled: true,
      } as never;
      const endpoint = {
        httpBaseUrl: "https://env-1.example.test/",
        wsBaseUrl: "wss://env-1.example.test/ws",
        providerKind: "cloudflare_tunnel",
      } as const;

      expect(
        yield* links.upsert({
          userId: "user-1",
          request,
          proof: {
            environmentId: "env-1",
            environmentPublicKey: "key-a",
            descriptor: { label: "Greendale Host" },
          } as never,
          endpoint,
        }),
      ).toBe(true);

      expect(
        yield* links.upsert({
          userId: "user-2",
          request,
          proof: {
            environmentId: "env-1",
            environmentPublicKey: "key-b",
            descriptor: { label: "Other Account Host" },
          } as never,
          endpoint,
        }),
      ).toBe(true);

      // A conflicting key cannot overwrite user-1's active link or revoke user-2's link for key-b.
      expect(
        yield* links.upsert({
          userId: "user-1",
          request,
          proof: {
            environmentId: "env-1",
            environmentPublicKey: "key-b",
            descriptor: { label: "Hijacked Host" },
          } as never,
          endpoint,
        }),
      ).toBe(false);

      const rowsAfterConflict = yield* Effect.promise(() =>
        db.select().from(relayEnvironmentLinks),
      );
      expect(
        rowsAfterConflict
          .map((row) => ({
            userId: row.userId,
            key: row.environmentPublicKey,
            label: row.environmentLabel,
            revoked: row.revokedAt !== null,
          }))
          .toSorted((a, b) => a.userId.localeCompare(b.userId)),
      ).toEqual([
        { userId: "user-1", key: "key-a", label: "Greendale Host", revoked: false },
        { userId: "user-2", key: "key-b", label: "Other Account Host", revoked: false },
      ]);

      // Same key can still update the active link.
      expect(
        yield* links.upsert({
          userId: "user-1",
          request,
          proof: {
            environmentId: "env-1",
            environmentPublicKey: "key-a",
            descriptor: { label: "Renamed Host" },
          } as never,
          endpoint,
        }),
      ).toBe(true);

      // After revoking user-1's link, key-b is allowed to claim (user-1, env-1).
      expect(yield* links.revokeForUser({ userId: "user-1", environmentId: "env-1" })).toBe(true);
      expect(
        yield* links.upsert({
          userId: "user-1",
          request,
          proof: {
            environmentId: "env-1",
            environmentPublicKey: "key-b",
            descriptor: { label: "Relinked Host" },
          } as never,
          endpoint,
        }),
      ).toBe(true);

      const finalRows = yield* Effect.promise(() => db.select().from(relayEnvironmentLinks));
      expect(
        finalRows
          .map((row) => ({
            userId: row.userId,
            key: row.environmentPublicKey,
            label: row.environmentLabel,
            revoked: row.revokedAt !== null,
          }))
          .toSorted((a, b) => a.userId.localeCompare(b.userId)),
      ).toEqual([
        { userId: "user-1", key: "key-b", label: "Relinked Host", revoked: false },
        { userId: "user-2", key: "key-b", label: "Other Account Host", revoked: true },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
