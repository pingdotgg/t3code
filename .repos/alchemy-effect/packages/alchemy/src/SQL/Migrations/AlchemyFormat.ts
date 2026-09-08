import * as Effect from "effect/Effect";
import {
  convertedRowInsertSql,
  findForeignHistory,
  matchForeignRows,
  toTimestampString,
} from "./Convert.ts";
import {
  MigrationError,
  MigrationHistoryConflictError,
  type MigrationDialect,
  type MigrationRecord,
  type SqlExecutor,
} from "./Format.ts";
import { classifyTable, tableColumns } from "./Introspect.ts";
import { quoteIdentifier, sqlLiteral } from "./Records.ts";

export const ALCHEMY_DEFAULT_TABLE = "__alchemy_migrations";

/**
 * THE Alchemy applied-migrations table: `id, hash, created_at, name,
 * applied_at`, name-keyed detection. This is deliberately drizzle's column
 * shape — a database whose history lives in `__drizzle_migrations` adopts
 * with a verbatim row copy — but Alchemy owns the table and it is the only
 * format Alchemy ever writes. Migrating from drizzle/prisma/wrangler
 * bookkeeping is a one-way conversion performed once (see `Convert.ts`).
 */
const createTableSql = (table: string, dialect: MigrationDialect): string => {
  const quoted = quoteIdentifier(table, dialect);
  switch (dialect) {
    case "sqlite":
      return `CREATE TABLE IF NOT EXISTS ${quoted} (
  id INTEGER PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric,
  name text,
  applied_at TEXT
);`;
    case "postgres":
      return `CREATE TABLE IF NOT EXISTS ${quoted} (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint,
  name text,
  applied_at timestamp with time zone DEFAULT now()
);`;
    case "mysql":
      return `CREATE TABLE IF NOT EXISTS ${quoted} (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT,
  name TEXT,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;
  }
};

const insertSql = (
  table: string,
  dialect: MigrationDialect,
  record: Pick<MigrationRecord, "name" | "hash" | "createdAtMillis">,
): string => {
  const quoted = quoteIdentifier(table, dialect);
  const applied = dialect === "sqlite" ? ", datetime('now')" : "";
  const appliedColumn = dialect === "sqlite" ? ", applied_at" : "";
  return `INSERT INTO ${quoted} (hash, created_at, name${appliedColumn}) VALUES (${sqlLiteral(record.hash)}, ${sqlLiteral(record.createdAtMillis ?? null)}, ${sqlLiteral(record.name)}${applied});`;
};

const renameSql = (
  from: string,
  to: string,
  dialect: MigrationDialect,
): string =>
  dialect === "mysql"
    ? `RENAME TABLE ${quoteIdentifier(from, dialect)} TO ${quoteIdentifier(to, dialect)};`
    : `ALTER TABLE ${quoteIdentifier(from, dialect)} RENAME TO ${quoteIdentifier(to, dialect)};`;

/**
 * Rebuild an in-place table (legacy Alchemy 3-column / oldest 2-column /
 * wrangler-shaped) into the Alchemy shape, backfilling `hash` and
 * `created_at` from local records matched by name. A recorded row with no
 * matching local file is a hard error — mirrors the same rule conversion
 * applies (see `matchForeignRows`).
 */
const rebuildInPlace = (options: {
  executor: SqlExecutor;
  table: string;
  records: ReadonlyArray<MigrationRecord>;
  /** SQL expression yielding the migration name from the old table. */
  nameExpr: string;
  tool: "legacy-alchemy" | "wrangler";
}) =>
  Effect.gen(function* () {
    const { executor, table, records, nameExpr } = options;
    const dialect = executor.dialect;
    const quoted = quoteIdentifier(table, dialect);
    const rows = yield* executor.query(
      `SELECT ${nameExpr} AS name, applied_at FROM ${quoted} ORDER BY id;`,
    );
    const matched = yield* matchForeignRows({
      history: {
        tool: options.tool,
        source: table,
        rows: rows
          .filter((row) => row.name !== null && row.name !== undefined)
          .map((row) => ({
            name: String(row.name),
            hash: undefined,
            createdAtMillis: undefined,
            appliedAt: toTimestampString(row.applied_at),
          })),
      },
      records,
    });

    const temp = `${table}_alchemy_upgrade`;
    yield* executor.batch([
      `DROP TABLE IF EXISTS ${quoteIdentifier(temp, dialect)};`,
      createTableSql(temp, dialect).replace(
        "CREATE TABLE IF NOT EXISTS",
        "CREATE TABLE",
      ),
      ...matched.map((row) => convertedRowInsertSql(temp, dialect, row)),
      `DROP TABLE ${quoted};`,
      renameSql(temp, table, dialect),
    ]);
  });

const ensureTable = (options: {
  executor: SqlExecutor;
  table: string;
  records: ReadonlyArray<MigrationRecord>;
}) =>
  Effect.gen(function* () {
    const { executor, table, records } = options;
    const shape = classifyTable(yield* tableColumns(executor, table));
    switch (shape) {
      case "absent": {
        // Greenfield for us — but possibly not for the database. Adopt any
        // history the previous tool (drizzle-kit / prisma / wrangler) left
        // behind: copy it into our table ONCE and freeze theirs. One-way.
        const history = yield* findForeignHistory({ executor, table });
        const converted = history
          ? yield* matchForeignRows({ history, records })
          : [];
        yield* executor.batch([
          createTableSql(table, executor.dialect),
          ...converted.map((row) =>
            convertedRowInsertSql(table, executor.dialect, row),
          ),
        ]);
        return;
      }
      case "drizzle-shaped":
        // Already our column shape (shared with drizzle v1) — including
        // the case where the user pointed `table` straight at an existing
        // `__drizzle_migrations`. Adopt in place.
        return;
      case "legacy-alchemy":
        yield* rebuildInPlace({
          executor,
          table,
          records,
          nameExpr: "name",
          tool: "legacy-alchemy",
        });
        return;
      case "legacy-2col":
        yield* rebuildInPlace({
          executor,
          table,
          records,
          nameExpr: "id",
          tool: "legacy-alchemy",
        });
        return;
      case "wrangler":
        // A wrangler table at OUR resolved table name (e.g. legacy D1
        // state pinned to `d1_migrations`, or a wrangler user's table
        // adopted under an explicit `table:`): convert it in place.
        yield* rebuildInPlace({
          executor,
          table,
          records,
          nameExpr: "name",
          tool: "wrangler",
        });
        return;
      case "unknown":
        return yield* new MigrationError({
          message:
            `Migrations table "${table}" has an unrecognized column layout; ` +
            `refusing to write bookkeeping into it.`,
        });
    }
  });

const appliedNames = (executor: SqlExecutor, table: string) =>
  executor
    .query(`SELECT name FROM ${quoteIdentifier(table, executor.dialect)};`)
    .pipe(
      Effect.map(
        (rows) =>
          new Set(
            rows
              .map((row) => row.name)
              .filter((name) => name !== null && name !== undefined)
              .map(String),
          ),
      ),
    );

/**
 * Apply pending migrations with Alchemy's bookkeeping. Idempotent: each
 * migration's statements and its bookkeeping INSERT go through
 * `executor.batch` as one unit (a transaction on pg/mysql, one batched
 * query on D1, which has no transactions over HTTP).
 *
 * Applied-detection is name-keyed with layout aliasing: pre-registry
 * Alchemy recorded drizzle-layout migrations under `<dir>/migration.sql`
 * while current records key them by `<dir>`, so both keys are honored.
 */
export const applyAlchemyFormat = (options: {
  executor: SqlExecutor;
  table: string;
  records: ReadonlyArray<MigrationRecord>;
}): Effect.Effect<void, MigrationError | MigrationHistoryConflictError> =>
  Effect.gen(function* () {
    const { executor, table, records } = options;
    if (records.length === 0) return;
    yield* ensureTable({ executor, table, records });
    const applied = yield* appliedNames(executor, table);
    for (const record of records) {
      if (
        applied.has(record.name) ||
        applied.has(`${record.name}/migration.sql`) ||
        applied.has(record.name.replace(/\/migration\.sql$/, ""))
      ) {
        continue;
      }
      yield* executor.batch([
        ...record.statements,
        insertSql(table, executor.dialect, record),
      ]);
    }
  });
