import * as Effect from "effect/Effect";
import {
  inlineSqlParams,
  MigrationError,
  type SqlExecutor,
} from "../../SQL/Migrations/index.ts";

/**
 * The minimal query surface the migration flow needs: run (possibly
 * multi-statement) SQL and return the D1 HTTP API's result envelope. Two
 * implementations exist:
 *
 * - the cloud executor (distilled's `d1.queryDatabase`);
 * - the local executor (`LocalD1Gateway.ts`), which tunnels the same
 *   protocol into the local workerd D1 simulator.
 */
export interface D1QueryResult {
  result: Array<{
    results?: unknown;
    success?: boolean | null;
    meta?: unknown;
  }>;
}

export type D1SqlExecutor<E = unknown, R = never> = (
  sql: string,
) => Effect.Effect<D1QueryResult, E, R>;

/**
 * Adapt a raw D1 executor into the registry's {@link SqlExecutor} contract
 * (see `src/SQL/Migrations/`). Parameters are inlined as SQL literals — the
 * D1 HTTP protocol path here is raw-SQL-only, and the only parametrized
 * queries are the migration formats' own bookkeeping. Batches join into a
 * single multi-statement query: D1 over HTTP has no transactions, so one
 * batched call is the closest available unit (matching wrangler's own
 * behavior).
 */
export const makeD1MigrationExecutor = <E>(
  raw: D1SqlExecutor<E>,
): SqlExecutor => ({
  dialect: "sqlite",
  query: (sql, params) =>
    raw(
      params && params.length > 0
        ? inlineSqlParams(sql, params, "sqlite")
        : sql,
    ).pipe(
      Effect.map(
        (result) =>
          (result.result[0]?.results ?? []) as Array<Record<string, unknown>>,
      ),
      Effect.mapError(
        (cause) =>
          new MigrationError({
            message: `D1 query failed: ${String(cause)}`,
            cause,
          }),
      ),
    ),
  batch: (statements) =>
    raw(
      statements
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0)
        .map((statement) =>
          statement.endsWith(";") ? statement : `${statement};`,
        )
        .join("\n"),
    ).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new MigrationError({
            message: `D1 migration batch failed: ${String(cause)}`,
            cause,
          }),
      ),
    ),
});
