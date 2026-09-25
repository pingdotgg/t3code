import * as Effect from "effect/Effect";
import type { Connection } from "mysql2/promise";
import { MigrationError, type SqlExecutor } from "./Format.ts";

/**
 * Adapt an open `mysql2` connection into the registry's
 * {@link SqlExecutor}. Batches run in a transaction (MySQL DDL
 * auto-commits regardless, matching the previous statement-by-statement
 * behavior).
 *
 * The `mysql2` import is type-only — how the connection is opened stays
 * with the database provider.
 */
export const makeMySQLMigrationExecutor = (
  connection: Connection,
): SqlExecutor => ({
  dialect: "mysql",
  query: (sql, params) =>
    Effect.tryPromise({
      try: () =>
        connection
          .query(sql, params ? [...params] : undefined)
          .then(([rows]) => rows as Array<Record<string, unknown>>),
      catch: (cause) =>
        new MigrationError({
          message: `mysql query failed: ${String(cause)}`,
          cause,
        }),
    }),
  batch: (statements) =>
    Effect.tryPromise({
      try: async () => {
        await connection.query("START TRANSACTION");
        try {
          for (const statement of statements) {
            await connection.query(statement);
          }
          await connection.query("COMMIT");
        } catch (error) {
          await connection.query("ROLLBACK").catch(() => {});
          throw error;
        }
      },
      catch: (cause) =>
        new MigrationError({
          message: `mysql migration batch failed: ${String(cause)}`,
          cause,
        }),
    }),
});
