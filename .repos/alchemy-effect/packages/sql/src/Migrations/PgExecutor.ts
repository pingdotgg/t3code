import * as Effect from "effect/Effect";
import type { Client } from "pg";
import { MigrationError, type SqlExecutor } from "./Format.ts";

/**
 * Adapt an open `pg` client into the registry's {@link SqlExecutor}.
 * Batches run in a transaction so a migration and its bookkeeping INSERT
 * commit (or roll back) together.
 *
 * The `pg` import is type-only — how the client is opened (Neon connection
 * URI, PlanetScale temporary role, …) stays with the database provider.
 */
export const makePgMigrationExecutor = (client: Client): SqlExecutor => ({
  dialect: "postgres",
  query: (sql, params) =>
    Effect.tryPromise({
      try: () =>
        client
          .query(sql, (params ?? []) as unknown[])
          .then((result) => result.rows as Array<Record<string, unknown>>),
      catch: (cause) =>
        new MigrationError({
          message: `postgres query failed: ${String(cause)}`,
          cause,
        }),
    }),
  batch: (statements) =>
    Effect.tryPromise({
      try: async () => {
        await client.query("BEGIN");
        try {
          for (const statement of statements) {
            await client.query(statement);
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      },
      catch: (cause) =>
        new MigrationError({
          message: `postgres migration batch failed: ${String(cause)}`,
          cause,
        }),
    }),
});
