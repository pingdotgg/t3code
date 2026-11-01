import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ne } from "drizzle-orm";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { PgDialect } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks, relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

describe("EnvironmentLinks", () => {
  it.effect("updates labels only for the user’s verified active link", () => {
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
                return Effect.void;
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      yield* links.updateLabel({
        userId: "user-1",
        environmentId: "env-1",
        environmentPublicKey: "verified-public-key",
        label: "Studio Mac",
        checkedAt: "2026-08-20T12:00:00.000Z",
      });

      expect(updateValues).toHaveLength(1);
      expect(updateValues[0]?.environmentLabel).toBe("Studio Mac");
      expect(updateValues[0]).not.toHaveProperty("updatedAt");
      expect(updateValues[0]?.labelUpdatedAt).toBe("2026-08-20T12:00:00.000Z");
      expect(whereConditions).toHaveLength(1);

      const query = new PgDialect().sqlToQuery(whereConditions[0] as never);
      expect(query.sql).toContain('"relay_environment_links"."user_id" = $1');
      expect(query.sql).toContain('"relay_environment_links"."environment_id" = $2');
      expect(query.sql).toContain('"relay_environment_links"."environment_public_key" = $3');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
      expect(query.sql).toContain(
        'coalesce("relay_environment_links"."label_updated_at", "relay_environment_links"."updated_at") <= $4',
      );
      expect(query.params).toEqual([
        "user-1",
        "env-1",
        "verified-public-key",
        "2026-08-20T12:00:00.000Z",
      ]);
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });

  it.effect("updates every user’s link to the key when the environment pushes its label", () => {
    const whereConditions: Array<unknown> = [];
    const fakeDb = {
      update: () => ({
        set: () => ({
          where: (condition: unknown) => {
            whereConditions.push(condition);
            return Effect.void;
          },
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      yield* links.recordEnvironmentLabel({
        environmentId: "env-1",
        environmentPublicKey: "verified-public-key",
        label: "Studio Mac",
      });

      // Stamped with relay time (the test clock starts at the epoch).
      const query = new PgDialect().sqlToQuery(whereConditions[0] as never);
      expect(query.sql).not.toContain("user_id");
      expect(query.sql).toContain('"relay_environment_links"."environment_public_key" = $2');
      expect(query.sql).toContain(
        'coalesce("relay_environment_links"."label_updated_at", "relay_environment_links"."updated_at") <= $3',
      );
      expect(query.params).toEqual(["env-1", "verified-public-key", "1970-01-01T00:00:00.000Z"]);
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });
  it.effect(
    "renames disabled links without withdrawing newer tunnels or accepting stale labels",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pg = yield* Effect.acquireRelease(
          Effect.promise(() => PGlite.create()),
          (client) => Effect.promise(() => client.close()),
        );
        const migrationsDir = new URL("../../migrations/postgres/", import.meta.url).pathname;
        for (const name of (yield* fs.readDirectory(migrationsDir)).toSorted()) {
          const migration = yield* fs.readFileString(`${migrationsDir}${name}/migration.sql`);
          yield* Effect.promise(() => pg.exec(migration));
        }
        const at = (minute: number) => `2026-10-28T12:${minute}:00.000Z`;
        yield* Effect.promise(() =>
          pg.query(
            `
        insert into relay_environment_links
          (user_id, environment_id, environment_public_key, endpoint_http_base_url,
           endpoint_ws_base_url, endpoint_provider_kind, managed_tunnels_enabled, created_at, updated_at)
          values ('user-1', 'env-1', 'key', 'https://e', 'wss://e', 'direct', false, $1, $1)
      `,
            [at(10)],
          ),
        );
        yield* Effect.promise(() =>
          pg.query(
            `
        insert into relay_managed_endpoint_allocations
          (user_id, environment_id, hostname, tunnel_id, tunnel_name, created_at, updated_at)
          values ('user-1', 'env-1', 'host', 'live-tunnel', 'tunnel', $1, $1)
      `,
            [at(20)],
          ),
        );
        const database = drizzle({ client: pg });
        const insertion = database.insert(relayEnvironmentLinks);
        const updating = database.update(relayEnvironmentLinks);
        const pushStarted = yield* Deferred.make<void>();
        const releasePush = yield* Deferred.make<void>();
        const db = {
          insert: () => ({
            values: (values: Parameters<typeof insertion.values>[0]) => ({
              onConflictDoUpdate: (
                conflict: Parameters<ReturnType<typeof insertion.values>["onConflictDoUpdate"]>[0],
              ) =>
                Effect.promise(() =>
                  database
                    .insert(relayEnvironmentLinks)
                    .values(values)
                    .onConflictDoUpdate(conflict),
                ),
            }),
          }),
          update: () => ({
            set: (values: Parameters<typeof updating.set>[0]) => ({
              where: (condition: Parameters<ReturnType<typeof updating.set>["where"]>[0]) =>
                Effect.gen(function* () {
                  if (values.environmentLabel === "In-flight name") {
                    yield* Deferred.succeed(pushStarted, undefined);
                    yield* Deferred.await(releasePush);
                  }
                  return yield* Effect.promise(() =>
                    database.update(relayEnvironmentLinks).set(values).where(condition),
                  );
                }),
            }),
          }),
        } as unknown as RelayDb.RelayDb["Service"];
        const links = yield* EnvironmentLinks.EnvironmentLinks.pipe(
          Effect.provide(
            EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db))),
          ),
        );
        for (const [minute, key, label] of [
          [30, "key", "Latest name"],
          [25, "key", "Stale status"],
          [40, "wrong-key", "Unverified name"],
        ] as const) {
          yield* links.updateLabel({
            userId: "user-1",
            environmentId: "env-1",
            environmentPublicKey: key,
            label,
            checkedAt: at(minute),
          });
        }
        const rows = yield* Effect.promise(() => database.select().from(relayEnvironmentLinks));
        expect(rows[0]).toMatchObject({
          environmentLabel: "Latest name",
          updatedAt: at(10),
          labelUpdatedAt: at(30),
        });
        const counted = yield* Effect.promise(() =>
          database
            .select({ environmentId: relayManagedEndpointAllocations.environmentId })
            .from(relayManagedEndpointAllocations)
            .where(
              ManagedTunnelLimits.countedAllocations({
                userId: "user-1",
                environmentId: "other",
                pendingCutoff: at(45),
                environment: ne,
              }),
            ),
        );
        expect(counted).toEqual([{ environmentId: "env-1" }]);
        yield* TestClock.setTime(Date.parse(at(40)));
        for (const [challengeAt, key, proofLabel, expectedLabel, expectedWatermark] of [
          [20, "key", "Stale link proof", "Latest name", 30],
          [35, "key", "Fresh link proof", "Fresh link proof", 35],
          [15, "replacement-key", "Replacement host", "Replacement host", 15],
        ] as const) {
          yield* links.upsert({
            userId: "user-1",
            challengeIssuedAt: at(challengeAt),
            request: {
              notificationsEnabled: false,
              liveActivitiesEnabled: false,
              managedTunnelsEnabled: false,
            } as never,
            proof: {
              environmentId: "env-1",
              environmentPublicKey: key,
              iat: Date.parse(at(55)) / 1_000,
              descriptor: { label: proofLabel },
            } as never,
            endpoint: {
              httpBaseUrl: "https://e",
              wsBaseUrl: "wss://e",
              providerKind: "direct",
            } as never,
          });
          const [linked] = yield* Effect.promise(() =>
            database.select().from(relayEnvironmentLinks),
          );
          expect(linked).toMatchObject({
            environmentLabel: expectedLabel,
            labelUpdatedAt: at(expectedWatermark),
            environmentPublicKey: key,
            updatedAt: at(40),
          });
        }
        yield* Effect.promise(() =>
          database.update(relayEnvironmentLinks).set({
            environmentPublicKey: "key",
            environmentLabel: "Before rename",
            labelUpdatedAt: at(41),
            updatedAt: at(41),
          }),
        );
        yield* TestClock.setTime(Date.parse(at(45)));
        const inFlightPush = yield* links
          .recordEnvironmentLabel({
            environmentId: "env-1",
            environmentPublicKey: "key",
            label: "In-flight name",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(pushStarted);
        yield* TestClock.setTime(Date.parse(at(50)));
        yield* links.upsert({
          userId: "user-1",
          challengeIssuedAt: at(42),
          request: {
            notificationsEnabled: false,
            liveActivitiesEnabled: false,
            managedTunnelsEnabled: false,
          } as never,
          proof: {
            environmentId: "env-1",
            environmentPublicKey: "key",
            descriptor: { label: "Old proof" },
          } as never,
          endpoint: {
            httpBaseUrl: "https://e",
            wsBaseUrl: "wss://e",
            providerKind: "direct",
          } as never,
        });
        yield* Deferred.succeed(releasePush, undefined);
        yield* Fiber.join(inFlightPush);
        const [afterRace] = yield* Effect.promise(() =>
          database.select().from(relayEnvironmentLinks),
        );
        expect(afterRace).toMatchObject({
          environmentLabel: "In-flight name",
          labelUpdatedAt: at(45),
          updatedAt: at(50),
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("carries the webhook-hold opt-in over only from links with the same key", () => {
    const inserted: Array<Record<string, unknown>> = [];
    const fakeDb = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { onConflictDoUpdate: () => Effect.void };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      yield* links.upsert({
        userId: "user-1",
        challengeIssuedAt: "1970-01-01T00:00:00.000Z",
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
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });

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
