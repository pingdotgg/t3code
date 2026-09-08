import type { Database } from "bun:sqlite";
import * as Effect from "effect/Effect";
import { MigrationError, type SqlExecutor } from "@/SQL/Migrations/index.ts";

/**
 * A {@link SqlExecutor} over an in-memory `bun:sqlite` database — the unit
 * test stand-in for the D1 HTTP executor / local workerd tunnel. Batches run
 * in a real transaction, so mid-batch failures roll back like D1's batched
 * query does.
 */
export const makeSqliteExecutor = (db: Database): SqlExecutor => ({
  dialect: "sqlite",
  query: (sql, params) =>
    Effect.try({
      try: () =>
        db.query(sql).all(...((params ?? []) as never[])) as Array<
          Record<string, unknown>
        >,
      catch: (cause) => new MigrationError({ message: String(cause), cause }),
    }),
  batch: (statements) =>
    Effect.try({
      try: () => {
        db.run("BEGIN");
        try {
          for (const statement of statements) db.run(statement);
          db.run("COMMIT");
        } catch (error) {
          try {
            db.run("ROLLBACK");
          } catch {
            // already rolled back
          }
          throw error;
        }
      },
      catch: (cause) => new MigrationError({ message: String(cause), cause }),
    }),
});

/** List user table names (excluding sqlite internals). */
export const tableNames = (db: Database): string[] =>
  (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
