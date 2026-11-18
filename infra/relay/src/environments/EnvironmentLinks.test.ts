import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PgDialect } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks, relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";

describe("EnvironmentLinks", () => {
  it.effect("carries the webhook-hold opt-in over only from links with the same key", () => {
    const inserted: Array<Record<string, unknown>> = [];
    const fakeDb = {
      $client: { withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect },
      select: () => ({ from: () => ({ where: () => ({ for: () => Effect.succeed([]) }) }) }),
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
    { when: "a concurrent first link", raced: tunnelLink, moved: false },
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
        update: (table: unknown) => {
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
          "lock",
          ...(previous === undefined ? ["insert"] : []),
          ...(raced === undefined ? [] : ["lock"]),
          "link",
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
                  returning: (selection: unknown) => {
                    expect(selection).toBeDefined();
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
