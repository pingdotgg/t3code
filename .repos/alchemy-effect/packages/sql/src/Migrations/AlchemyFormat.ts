import * as Effect from "effect/Effect";
import {
  convertedRowInsertSql,
  findForeignHistory,
  matchForeignRows,
  toTimestampString,
} from "./Convert.ts";
import {
  describeRewrittenHistory,
  MigrationError,
  RewrittenMigrationHistoryError,
  type MigrationApplyError,
  type MigrationDialect,
  type MigrationHistoryConflictError,
  type MigrationRecord,
  type SqlExecutor,
} from "./Format.ts";
import { classifyTable, tableColumns } from "./Introspect.ts";
import { bookkeepingColumns, quoteIdentifier, scalarText, sqlLiteral } from "./Utils.ts";

export const ALCHEMY_DEFAULT_TABLE = "__alchemy_migrations";

/**
 * THE Alchemy applied-migrations table: `id, hash, created_at, name,
 * applied_at`, name-keyed detection. This is deliberately drizzle's column
 * shape — a database whose history lives in `__drizzle_migrations` adopts
 * with a verbatim row copy — but Alchemy owns the table and it is the only
 * format Alchemy ever writes. Migrating from drizzle/prisma/wrangler
 * bookkeeping is a one-way conversion performed once (see `Convert.ts`).
 */
const createTableSql = (
  table: string,
  dialect: MigrationDialect,
  id?: SqlExecutor["migrationTableId"],
): string => {
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
      if (id === "spanner") {
        return `CREATE TABLE IF NOT EXISTS ${quoted} (
  id varchar(36) NOT NULL DEFAULT spanner.generate_uuid(),
  hash text NOT NULL,
  created_at bigint,
  name text,
  applied_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
)`;
      }
      return `CREATE TABLE IF NOT EXISTS ${quoted} (
  id ${id === "uuid" ? "uuid DEFAULT gen_random_uuid()" : "SERIAL"} PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint,
  name text,
  applied_at timestamp with time zone DEFAULT now()
);`;
    case "googlesql":
      return `CREATE TABLE IF NOT EXISTS ${quoted} (
  \`id\` STRING(36) NOT NULL DEFAULT (GENERATE_UUID()),
  \`hash\` STRING(MAX) NOT NULL,
  \`created_at\` INT64,
  \`name\` STRING(MAX),
  \`applied_at\` TIMESTAMP DEFAULT (CURRENT_TIMESTAMP())
) PRIMARY KEY (\`id\`)`;
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
  const columns =
    dialect === "sqlite"
      ? bookkeepingColumns(dialect, "hash", "created_at", "name", "applied_at")
      : bookkeepingColumns(dialect, "hash", "created_at", "name");
  return `INSERT INTO ${quoted} (${columns}) VALUES (${sqlLiteral(record.hash, dialect)}, ${sqlLiteral(record.createdAtMillis ?? null, dialect)}, ${sqlLiteral(record.name, dialect)}${applied});`;
};

const renameSql = (from: string, to: string, dialect: MigrationDialect): string =>
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
    if (executor.transactionalDdl === false) {
      return yield* new MigrationError({
        message: `Cannot automatically rebuild migration history in "${table}" on a target without transactional DDL. Convert the history explicitly before deploying.`,
      });
    }
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
      createTableSql(temp, dialect, executor.migrationTableId).replace(
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
        const converted = history ? yield* matchForeignRows({ history, records }) : [];
        if (converted.length > 0 && executor.transactionalDdl === false) {
          return yield* new MigrationError({
            message: `Cannot automatically copy foreign migration history into "${table}" without transactional DDL. Convert the history explicitly before deploying.`,
          });
        }
        yield* executor.batch([
          createTableSql(table, executor.dialect, executor.migrationTableId),
          ...converted.map((row) => convertedRowInsertSql(table, executor.dialect, row)),
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

const aliasesOf = (name: string): readonly string[] => [
  name,
  `${name}/migration.sql`,
  name.replace(/\/migration\.sql$/, ""),
];

const appliedHistory = (executor: SqlExecutor, table: string) =>
  executor
    .query(
      `SELECT ${bookkeepingColumns(executor.dialect, "name", "hash")} FROM ${quoteIdentifier(table, executor.dialect)};`,
    )
    .pipe(
      Effect.map((rows) => {
        const byName = new Map<string, string | undefined>();
        for (const row of rows) {
          if (row.name === null || row.name === undefined) continue;
          byName.set(
            scalarText(row.name),
            row.hash === null || row.hash === undefined ? undefined : scalarText(row.hash),
          );
        }
        return byName;
      }),
    );

const lookupApplied = (
  byName: Map<string, string | undefined>,
  name: string,
): { name: string; hash: string | undefined } | undefined => {
  for (const alias of aliasesOf(name)) {
    if (byName.has(alias)) {
      return { name: alias, hash: byName.get(alias) };
    }
  }
  return undefined;
};

const applyPending = (options: {
  executor: SqlExecutor;
  table: string;
  records: ReadonlyArray<MigrationRecord>;
  applied: Map<string, string | undefined>;
}) =>
  Effect.gen(function* () {
    const { executor, table, records, applied } = options;
    for (const record of records) {
      if (lookupApplied(applied, record.name)) continue;
      const bookkeeping = insertSql(table, executor.dialect, record);
      const send = executor.applyMigration
        ? executor.applyMigration(record, bookkeeping)
        : executor.batch([...record.statements, bookkeeping]);
      // A batch can commit and still lose its reply. Its bookkeeping row says
      // whether it landed, so a lost reply is not a failure and only a
      // transient failure that did not land is resent (#1889).
      yield* send.pipe(
        Effect.catchTag(
          "MigrationError",
          Effect.fn(function* (error) {
            const after = yield* appliedHistory(executor, table);
            if (lookupApplied(after, record.name)) return;
            if (!error.transient) return yield* error;
            yield* send;
          }),
        ),
      );
    }
  });

/**
 * Apply pending migrations with Alchemy's bookkeeping. Idempotent: each
 * migration's statements and its bookkeeping INSERT go through
 * `executor.batch` as one unit (a transaction on pg/mysql, one batched
 * query on D1, which has no transactions over HTTP). Nontransactional DDL
 * targets can supply `applyMigration` to checkpoint individual statements.
 *
 * Applied-detection is name-keyed with layout aliasing: pre-registry
 * Alchemy recorded drizzle-layout migrations under `<dir>/migration.sql`
 * while current records key them by `<dir>`, so both keys are honored.
 * An already-applied name whose local hash changed, or a recorded name
 * with no local file, is a hard {@link RewrittenMigrationHistoryError}
 * rather than a silent skip that would persist the new hashes.
 */
export const applyAlchemyFormat = (options: {
  executor: SqlExecutor;
  table: string;
  records: ReadonlyArray<MigrationRecord>;
}): Effect.Effect<void, MigrationApplyError> =>
  Effect.gen(function* () {
    const { executor, table, records } = options;
    yield* ensureTable({ executor, table, records });
    const applied = yield* appliedHistory(executor, table);
    const localNames = new Set(records.flatMap((record) => aliasesOf(record.name)));
    const changed: string[] = [];
    const removed: string[] = [];
    for (const name of applied.keys()) {
      if (!localNames.has(name)) removed.push(name);
    }
    for (const record of records) {
      const row = lookupApplied(applied, record.name);
      if (row?.hash && row.hash !== record.hash) {
        changed.push(record.name);
      }
    }
    if (changed.length > 0 || removed.length > 0) {
      changed.sort();
      removed.sort();
      return yield* new RewrittenMigrationHistoryError({
        changed,
        removed,
        message:
          `Applied migration history in "${table}" does not match the local files ` +
          `(${describeRewrittenHistory({ changed, removed })}). ` +
          "Add a new forward migration instead of editing or deleting already-applied files.",
      });
    }
    yield* applyPending({ executor, table, records, applied });
  });

/**
 * {@link applyAlchemyFormat} without the rewritten-history check: applied
 * names are skipped regardless of their hash. For runtime appliers (Durable
 * Object SQLite) where failing would take every instance down after a
 * deploy that already succeeded.
 */
export const applyPendingAlchemyFormat = (options: {
  executor: SqlExecutor;
  table: string;
  records: ReadonlyArray<MigrationRecord>;
}): Effect.Effect<void, MigrationError | MigrationHistoryConflictError> =>
  Effect.gen(function* () {
    const { executor, table, records } = options;
    yield* ensureTable({ executor, table, records });
    const applied = yield* appliedHistory(executor, table);
    yield* applyPending({ executor, table, records, applied });
  });
