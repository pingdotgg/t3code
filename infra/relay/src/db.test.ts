import { expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as RelayDb from "./db.ts";
import { relayEnvironmentLifecycleLeases } from "./persistence/schema.ts";

it.effect("leases lifecycle work without changing its transaction boundary", () => {
  const calls: Array<string> = [];
  let ownerId = "";
  let insertedExpiresAt: SQL | undefined;
  let updatedExpiresAt: SQL | undefined;
  let leaseExpiryCondition: SQL | undefined;
  const db = {
    $client: {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.sync(() => {
          calls.push("transaction");
        }).pipe(Effect.andThen(effect)),
    },
    insert: (table: unknown) => {
      expect(table).toBe(relayEnvironmentLifecycleLeases);
      return {
        values: (values: { readonly ownerId: string; readonly expiresAt: SQL }) => {
          ownerId = values.ownerId;
          insertedExpiresAt = values.expiresAt;
          calls.push("acquire");
          return {
            onConflictDoUpdate: (config: {
              readonly set: { readonly expiresAt: SQL };
              readonly setWhere: SQL;
            }) => {
              updatedExpiresAt = config.set.expiresAt;
              leaseExpiryCondition = config.setWhere;
              return {
                returning: () => Effect.succeed([{ ownerId }]),
              };
            },
          };
        },
      };
    },
    delete: (table: unknown) => {
      expect(table).toBe(relayEnvironmentLifecycleLeases);
      return {
        where: () =>
          Effect.sync(() => {
            calls.push("release");
          }),
      };
    },
  } as unknown as RelayDb.RelayDb["Service"];
  const layer = RelayDb.RelayTransactions.layer.pipe(
    Layer.provide(Layer.succeed(RelayDb.RelayDb, db)),
  );

  return Effect.gen(function* () {
    const transactions = yield* RelayDb.RelayTransactions;
    const result = yield* Effect.result(
      transactions.withEnvironmentLock(
        { userId: "user-1", environmentId: "environment-1" },
        Effect.sync(() => {
          calls.push("work");
        }).pipe(Effect.andThen(Effect.fail("expected failure" as const))),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(ownerId).not.toBe("");
    expect(calls).toEqual(["acquire", "work", "release"]);
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(insertedExpiresAt!).sql).toContain("now() + interval '30 seconds'");
    expect(dialect.sqlToQuery(updatedExpiresAt!).sql).toContain("now() + interval '30 seconds'");
    expect(dialect.sqlToQuery(leaseExpiryCondition!)).toEqual({
      sql: '"relay_environment_lifecycle_leases"."expires_at"::timestamptz <= now()',
      params: [],
    });
  }).pipe(Effect.provide(layer));
});
