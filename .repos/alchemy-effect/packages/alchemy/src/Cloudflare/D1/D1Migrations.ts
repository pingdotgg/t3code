import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import type { SqlFile } from "../../Sql/SqlFile.ts";

export interface ApplyMigrationsOptions {
  accountId: string;
  databaseId: string;
  migrationsTable: string;
  migrationsFiles: ReadonlyArray<SqlFile>;
}

interface TableColumn {
  name: string;
  type: string;
  pk: number;
}

interface SchemaInfo {
  exists: boolean;
  hasIdColumn: boolean;
  hasNameColumn: boolean;
  isLegacySchema: boolean;
  columns: TableColumn[];
}

const executeSQL = (
  accountId: string,
  databaseId: string,
  sql: string,
): Effect.Effect<
  d1.QueryDatabaseResponse,
  d1.QueryDatabaseError,
  Credentials | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const queryDb = yield* d1.queryDatabase;
    return yield* queryDb({ accountId, databaseId, sql });
  });

const detectSchema = (
  accountId: string,
  databaseId: string,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const result = yield* executeSQL(
      accountId,
      databaseId,
      `PRAGMA table_info(${migrationsTable});`,
    ).pipe(Effect.option);

    const columns: TableColumn[] = [];
    if (result._tag === "Some") {
      const rows = (result.value.result[0]?.results ?? []) as Array<{
        name: string;
        type: string;
        pk: number;
      }>;
      for (const row of rows) {
        columns.push({ name: row.name, type: row.type, pk: row.pk });
      }
    }

    if (columns.length === 0) {
      return {
        exists: false,
        hasIdColumn: false,
        hasNameColumn: false,
        isLegacySchema: false,
        columns,
      } satisfies SchemaInfo;
    }

    const names = columns.map((c) => c.name);
    const hasIdColumn = names.includes("id");
    const hasNameColumn = names.includes("name");
    const isLegacySchema =
      columns.length === 2 && !(hasIdColumn && hasNameColumn);

    return {
      exists: true,
      hasIdColumn,
      hasNameColumn,
      isLegacySchema,
      columns,
    } satisfies SchemaInfo;
  });

const migrateLegacySchema = (
  accountId: string,
  databaseId: string,
  migrationsTable: string,
  schema: SchemaInfo,
) =>
  Effect.gen(function* () {
    const primaryColumn =
      schema.columns.find((c) => c.pk === 1)?.name ?? schema.columns[0]?.name;
    if (!primaryColumn) {
      return yield* Effect.die(
        "Cannot migrate legacy migration table: no columns found",
      );
    }
    const tempTable = `${migrationsTable}_temp_migration`;
    yield* executeSQL(
      accountId,
      databaseId,
      `CREATE TABLE ${tempTable} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );`,
    );
    yield* executeSQL(
      accountId,
      databaseId,
      `INSERT INTO ${tempTable} (id, name, applied_at)
       SELECT
         printf('%05d', row_number() OVER (ORDER BY applied_at)) as id,
         ${primaryColumn} as name,
         applied_at
       FROM ${migrationsTable}
       ORDER BY applied_at;`,
    );
    yield* executeSQL(accountId, databaseId, `DROP TABLE ${migrationsTable};`);
    yield* executeSQL(
      accountId,
      databaseId,
      `ALTER TABLE ${tempTable} RENAME TO ${migrationsTable};`,
    );
  });

const ensureMigrationsTable = (
  accountId: string,
  databaseId: string,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const schema = yield* detectSchema(accountId, databaseId, migrationsTable);
    if (!schema.exists) {
      yield* executeSQL(
        accountId,
        databaseId,
        `CREATE TABLE ${migrationsTable} (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );`,
      );
      return;
    }
    if (schema.isLegacySchema || !schema.hasIdColumn || !schema.hasNameColumn) {
      yield* migrateLegacySchema(
        accountId,
        databaseId,
        migrationsTable,
        schema,
      );
    }
  });

const getAppliedMigrations = (
  accountId: string,
  databaseId: string,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const result = yield* executeSQL(
      accountId,
      databaseId,
      `SELECT name FROM ${migrationsTable};`,
    );
    const rows = (result.result[0]?.results ?? []) as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  });

const getNextSeq = (
  accountId: string,
  databaseId: string,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const result = yield* executeSQL(
      accountId,
      databaseId,
      `SELECT id FROM ${migrationsTable} ORDER BY id;`,
    );
    const rows = (result.result[0]?.results ?? []) as Array<{ id: string }>;
    let max = 0;
    for (const { id } of rows) {
      if (/^\d+$/.test(id)) {
        max = Math.max(max, Number.parseInt(id, 10));
      }
    }
    return max + 1;
  });

/**
 * Apply pending D1 migrations in order. Uses the wrangler-compatible
 * 3-column schema `(id TEXT PK, name TEXT, applied_at TEXT)`.
 */
export const applyMigrations = (options: ApplyMigrationsOptions) =>
  Effect.gen(function* () {
    const { accountId, databaseId, migrationsTable, migrationsFiles } = options;
    yield* ensureMigrationsTable(accountId, databaseId, migrationsTable);
    const applied = yield* getAppliedMigrations(
      accountId,
      databaseId,
      migrationsTable,
    );
    let nextSeq = yield* getNextSeq(accountId, databaseId, migrationsTable);

    for (const migration of migrationsFiles) {
      if (applied.has(migration.id)) continue;
      const migrationId = nextSeq.toString().padStart(5, "0");
      nextSeq += 1;
      // D1 over HTTP doesn't support transactions; run migration + record
      // in a single batched query.
      yield* executeSQL(
        accountId,
        databaseId,
        [
          migration.sql,
          `INSERT INTO ${migrationsTable} (id, name, applied_at) VALUES ('${migrationId}', '${migration.id}', datetime('now'));`,
        ].join("\n"),
      );
    }
  });
