import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PgDialect } from "drizzle-orm/pg-core";

import { RelayDb, type RelayDatabase } from "../db.ts";
import { relayEnvironmentLinks } from "../schema.ts";
import {
  agentAwarenessDeliveryUserCondition,
  EnvironmentLinks,
  layer,
} from "./EnvironmentLinks.ts";

describe("EnvironmentLinks", () => {
  it("selects users when either notifications or Live Activities are enabled", () => {
    const dialect = new PgDialect();
    const condition = agentAwarenessDeliveryUserCondition("env-1");
    expect(condition).toBeDefined();
    if (!condition) {
      throw new Error("Expected agent awareness delivery condition.");
    }
    const query = dialect.sqlToQuery(condition);

    expect(query.sql).toContain('"relay_environment_links"."environment_id" = $1');
    expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
    expect(query.sql).toContain('"relay_environment_links"."notifications_enabled" = $2');
    expect(query.sql).toContain('"relay_environment_links"."live_activities_enabled" = $3');
    expect(query.sql).toContain(" or ");
    expect(query.params).toEqual(["env-1", true, true]);
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
    } as unknown as RelayDatabase;

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks;
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
    }).pipe(Effect.provide(layer.pipe(Layer.provide(Layer.succeed(RelayDb, fakeDb)))));
  });
});
