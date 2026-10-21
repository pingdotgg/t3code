import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PgDialect } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks } from "../persistence/schema.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";

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
      expect(updateValues[0]?.updatedAt).toBe("2026-08-20T12:00:00.000Z");
      expect(whereConditions).toHaveLength(1);

      const query = new PgDialect().sqlToQuery(whereConditions[0] as never);
      expect(query.sql).toContain('"relay_environment_links"."user_id" = $1');
      expect(query.sql).toContain('"relay_environment_links"."environment_id" = $2');
      expect(query.sql).toContain('"relay_environment_links"."environment_public_key" = $3');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
      expect(query.sql).toContain('"relay_environment_links"."updated_at" <= $4');
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
      expect(query.sql).toContain('"relay_environment_links"."updated_at" <= $3');
      expect(query.params).toEqual(["env-1", "verified-public-key", "1970-01-01T00:00:00.000Z"]);
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb))),
      ),
    );
  });
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
