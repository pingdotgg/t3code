import * as Effect from "effect/Effect";
import {
  MigrationError,
  MigrationHistoryConflictError,
  type MigrationRecord,
  type SqlExecutor,
} from "./Format.ts";
import { classifyTable, tableColumns } from "./Introspect.ts";
import {
  quoteIdentifier,
  sqlLiteral,
  timestampPrefixMillis,
} from "./Records.ts";

/**
 * A row of applied history harvested from a foreign migration tool's table,
 * normalized for insertion into `__alchemy_migrations`.
 */
export interface ConvertedRow {
  name: string;
  hash: string | undefined;
  createdAtMillis: number | undefined;
  appliedAt: string | undefined;
}

export interface ForeignHistory {
  /** Which tool's bookkeeping this history came from. */
  tool: "drizzle" | "prisma" | "wrangler" | "legacy-alchemy";
  /** Display name of the source table (schema-qualified where relevant). */
  source: string;
  rows: ConvertedRow[];
}

/**
 * Normalize a timestamp-ish column value for re-insertion as a SQL
 * literal. Drivers differ: pg hands back JS Dates (whose default
 * stringification pg itself cannot parse — "GMT-0700 (…)"), sqlite hands
 * back strings.
 */
export const toTimestampString = (value: unknown): string | undefined =>
  value === null || value === undefined
    ? undefined
    : value instanceof Date
      ? value.toISOString()
      : String(value);

const qualify = (
  table: string,
  dialect: SqlExecutor["dialect"],
  schema?: string,
) =>
  schema
    ? `${quoteIdentifier(schema, dialect)}.${quoteIdentifier(table, dialect)}`
    : quoteIdentifier(table, dialect);

/**
 * Discover applied-migration history left behind by the tool a user is
 * migrating FROM — drizzle-kit, Prisma, or wrangler — so it can be copied
 * into Alchemy's own table once. This is a ONE-WAY migration: the foreign
 * table is read but never written or dropped (it is simply frozen), and
 * from that point on Alchemy's table is the only bookkeeping.
 *
 * Sources probed, most-specific first:
 * - drizzle: `__drizzle_migrations` (in the `drizzle` schema on Postgres) —
 *   drizzle's columns are Alchemy's columns, so rows copy verbatim.
 * - prisma: `_prisma_migrations` — `migration_name`/`checksum` map to
 *   `name`/`hash` (both are sha256 of `migration.sql`). A failed migration
 *   (`finished_at IS NULL`, not rolled back) aborts the conversion: it must
 *   be repaired with `prisma migrate resolve` first. Rolled-back rows are
 *   skipped.
 * - wrangler (sqlite): `d1_migrations` in wrangler's shape — names carry
 *   over; hashes backfill from local records.
 */
export const findForeignHistory = (options: {
  executor: SqlExecutor;
  /** The resolved Alchemy table — a source with this name is not foreign. */
  table: string;
}): Effect.Effect<ForeignHistory | undefined, MigrationError> =>
  Effect.gen(function* () {
    const { executor, table } = options;
    const dialect = executor.dialect;

    // drizzle
    const drizzleSchema = dialect === "postgres" ? "drizzle" : undefined;
    if (table !== "__drizzle_migrations") {
      const columns = yield* tableColumns(
        executor,
        "__drizzle_migrations",
        drizzleSchema,
      );
      if (classifyTable(columns) === "drizzle-shaped") {
        const rows = yield* executor.query(
          `SELECT hash, created_at, name, applied_at FROM ${qualify("__drizzle_migrations", dialect, drizzleSchema)} ORDER BY id;`,
        );
        return {
          tool: "drizzle" as const,
          source: drizzleSchema
            ? `${drizzleSchema}.__drizzle_migrations`
            : "__drizzle_migrations",
          rows: rows
            .filter((row) => row.name !== null && row.name !== undefined)
            .map((row) => ({
              name: String(row.name),
              hash:
                row.hash === null || row.hash === undefined
                  ? undefined
                  : String(row.hash),
              createdAtMillis:
                row.created_at === null || row.created_at === undefined
                  ? undefined
                  : Number(row.created_at),
              appliedAt: toTimestampString(row.applied_at),
            })),
        };
      }
    }

    // prisma
    if (table !== "_prisma_migrations") {
      const columns = yield* tableColumns(executor, "_prisma_migrations");
      const names = new Set(columns.map((c) => c.name));
      if (names.has("migration_name") && names.has("checksum")) {
        const rows = yield* executor.query(
          `SELECT migration_name, checksum, started_at, finished_at, rolled_back_at FROM ${quoteIdentifier("_prisma_migrations", dialect)};`,
        );
        const failed = rows.filter(
          (row) =>
            (row.finished_at === null || row.finished_at === undefined) &&
            (row.rolled_back_at === null || row.rolled_back_at === undefined),
        );
        if (failed.length > 0) {
          return yield* new MigrationError({
            message:
              `_prisma_migrations records ${failed.length} failed migration(s) ` +
              `(${failed.map((r) => String(r.migration_name)).join(", ")}). ` +
              `Repair them with "prisma migrate resolve" before migrating this ` +
              `database's bookkeeping to Alchemy.`,
          });
        }
        return {
          tool: "prisma" as const,
          source: "_prisma_migrations",
          rows: rows
            .filter(
              (row) =>
                row.finished_at !== null &&
                row.finished_at !== undefined &&
                (row.rolled_back_at === null ||
                  row.rolled_back_at === undefined),
            )
            .map((row) => ({
              name: String(row.migration_name),
              hash:
                row.checksum === null || row.checksum === undefined
                  ? undefined
                  : String(row.checksum),
              createdAtMillis: timestampPrefixMillis(
                String(row.migration_name),
              ),
              appliedAt: toTimestampString(row.finished_at),
            })),
        };
      }
    }

    // wrangler / pre-registry Alchemy on D1 (which shared the
    // d1_migrations name — covers state-lost adoption of old deploys)
    if (dialect === "sqlite" && table !== "d1_migrations") {
      const shape = classifyTable(
        yield* tableColumns(executor, "d1_migrations"),
      );
      if (
        shape === "wrangler" ||
        shape === "legacy-alchemy" ||
        shape === "legacy-2col"
      ) {
        const nameExpr = shape === "legacy-2col" ? "id" : "name";
        const rows = yield* executor.query(
          `SELECT ${nameExpr} AS name, applied_at FROM ${quoteIdentifier("d1_migrations", dialect)} ORDER BY id;`,
        );
        return {
          tool:
            shape === "wrangler"
              ? ("wrangler" as const)
              : ("legacy-alchemy" as const),
          source: "d1_migrations",
          rows: rows
            .filter((row) => row.name !== null && row.name !== undefined)
            .map((row) => ({
              name: String(row.name),
              hash: undefined,
              createdAtMillis: timestampPrefixMillis(String(row.name)),
              appliedAt: toTimestampString(row.applied_at),
            })),
        };
      }
    }

    return undefined;
  });

/**
 * Validate foreign history against the local migrations directory and fill
 * in missing hashes. Every foreign row must match a local record by name
 * (or by the `<dir>/migration.sql` ⇄ `<dir>` aliasing between flat and
 * directory layouts) — an unmatched row means migrations were applied that
 * this checkout does not have.
 */
export const matchForeignRows = (options: {
  history: ForeignHistory;
  records: ReadonlyArray<MigrationRecord>;
}): Effect.Effect<ConvertedRow[], MigrationHistoryConflictError> =>
  Effect.gen(function* () {
    const { history, records } = options;
    const byName = new Map(records.map((r) => [r.name, r]));
    const byAlias = new Map(
      records.flatMap((r) => [
        [`${r.name}/migration.sql`, r] as const,
        [r.name.replace(/\/migration\.sql$/, ""), r] as const,
      ]),
    );
    const matched: ConvertedRow[] = [];
    const unmatched: string[] = [];
    for (const row of history.rows) {
      const record = byName.get(row.name) ?? byAlias.get(row.name);
      if (!record) {
        unmatched.push(row.name);
        continue;
      }
      matched.push({
        ...row,
        hash: row.hash ?? record.hash,
        createdAtMillis: row.createdAtMillis ?? record.createdAtMillis,
      });
    }
    if (unmatched.length > 0) {
      return yield* new MigrationHistoryConflictError({
        table: history.source,
        unmatched,
        message:
          `While migrating ${history.tool} bookkeeping (${history.source}) to ` +
          `Alchemy, ${unmatched.length} recorded migration(s) match no local ` +
          `file: ${unmatched.join(", ")}. Migrations were applied to this ` +
          `database that are missing from the local environment.`,
      });
    }
    return matched;
  });

/** Render an INSERT for a converted history row into Alchemy's table. */
export const convertedRowInsertSql = (
  table: string,
  dialect: SqlExecutor["dialect"],
  row: ConvertedRow,
): string =>
  `INSERT INTO ${quoteIdentifier(table, dialect)} (hash, created_at, name, applied_at) VALUES (${sqlLiteral(row.hash ?? "")}, ${sqlLiteral(row.createdAtMillis ?? null)}, ${sqlLiteral(row.name)}, ${sqlLiteral(row.appliedAt ?? null)});`;
