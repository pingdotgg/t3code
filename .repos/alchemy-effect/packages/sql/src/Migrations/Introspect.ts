import * as Effect from "effect/Effect";
import type { MigrationError, SqlExecutor } from "./Format.ts";
import { quoteIdentifier, scalarText, sqlLiteral } from "./Utils.ts";

export interface TableColumn {
  name: string;
  type: string;
}

/**
 * List a table's columns (empty when the table doesn't exist), normalized
 * across dialects. `schema` defaults to the executor's `defaultSchema`, then
 * the connection's current/default schema.
 */
export const tableColumns = (
  executor: SqlExecutor,
  table: string,
  schema?: string,
): Effect.Effect<TableColumn[], MigrationError, never> => {
  switch (executor.dialect) {
    case "sqlite":
      return executor.query(`PRAGMA table_info(${quoteIdentifier(table, "sqlite")});`).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            name: String(row.name),
            type: scalarText(row.type ?? "").toUpperCase(),
          })),
        ),
        // A missing table yields an empty PRAGMA result, not an error, but
        // some tunnels surface it as one — treat both as "absent".
        Effect.orElseSucceed(() => []),
      );
    case "postgres":
      return executor
        .query(
          `SELECT column_name AS name, data_type AS type
             FROM information_schema.columns
            WHERE table_name = ${sqlLiteral(table)}
              AND table_schema = ${
                (schema ?? executor.defaultSchema)
                  ? sqlLiteral(schema ?? executor.defaultSchema)
                  : "current_schema()"
              }
            ORDER BY ordinal_position;`,
        )
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              name: String(row.name),
              type: scalarText(row.type ?? "").toUpperCase(),
            })),
          ),
        );
    case "mysql":
      return executor
        .query(
          `SELECT COLUMN_NAME AS name, DATA_TYPE AS type
             FROM information_schema.columns
            WHERE table_name = ${sqlLiteral(table)}
              AND table_schema = ${schema ? sqlLiteral(schema) : "DATABASE()"}
            ORDER BY ORDINAL_POSITION;`,
        )
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              name: String(row.name),
              type: scalarText(row.type ?? "").toUpperCase(),
            })),
          ),
          Effect.orElseSucceed(() => []),
        );
    case "googlesql":
      // The default schema is the empty string; named schemas qualify tables.
      return executor
        .query(
          `SELECT COLUMN_NAME AS name, SPANNER_TYPE AS type
             FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = ${sqlLiteral(table, "googlesql")}
              AND TABLE_SCHEMA = ${sqlLiteral(schema ?? "", "googlesql")}
            ORDER BY ORDINAL_POSITION`,
        )
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              name: scalarText(row.name),
              type: scalarText(row.type ?? "").toUpperCase(),
            })),
          ),
        );
  }
};

/**
 * Classify an existing applied-migrations table by column set — the same
 * versioning trick drizzle uses (there is deliberately no version column):
 *
 * - `absent`         — no table
 * - `drizzle-shaped` — has `hash` (drizzle v1 / alchemy current)
 * - `legacy-alchemy` — `name` + `applied_at`, no `hash` (pre-registry Alchemy)
 * - `legacy-2col`    — two columns, no `name`/`hash` (oldest Alchemy shape,
 *   where the primary column carried the migration name)
 * - `wrangler`       — `id`/`name`/`applied_at` with an INTEGER id (already
 *   wrangler's real shape)
 * - `unknown`        — anything else
 */
export type TableShape =
  | "absent"
  | "drizzle-shaped"
  | "legacy-alchemy"
  | "legacy-2col"
  | "wrangler"
  | "unknown";

export const classifyTable = (columns: TableColumn[]): TableShape => {
  if (columns.length === 0) return "absent";
  const names = new Set(columns.map((c) => c.name));
  if (names.has("hash")) return "drizzle-shaped";
  if (names.has("name") && names.has("applied_at")) {
    const id = columns.find((c) => c.name === "id");
    return id && /INT/.test(id.type) ? "wrangler" : "legacy-alchemy";
  }
  if (columns.length === 2 && !names.has("name")) return "legacy-2col";
  return "unknown";
};
