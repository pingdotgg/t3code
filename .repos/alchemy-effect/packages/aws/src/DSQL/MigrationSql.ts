import {
  MigrationError,
  readMigrationRecords,
  scanSqlScript,
  type NormalizedMigrationsInput,
} from "@alchemy.run/sql/Migrations";
import { hashMigrations } from "@alchemy.run/sql/SqlFile";
import * as Effect from "effect/Effect";

/**
 * Split a PostgreSQL script without splitting quoted values, identifiers,
 * dollar-quoted bodies, or nested comments. Each statement's `code` masks
 * literals and comments at the same offsets as its `sql`, hiding them from
 * capability checks.
 */
export const parseDsqlStatements = (sql: string) =>
  scanSqlScript(sql, "postgres").map((statement) => {
    if (statement.unterminated) {
      throw new Error(`Unterminated SQL ${statement.unterminated}`);
    }
    return { sql: statement.sql, code: statement.code };
  });

/** Validate known DSQL incompatibilities; this is not a full SQL parser. */
export const prepareDsqlStatements = (sql: string, migration: string) =>
  Effect.try({
    try: () =>
      parseDsqlStatements(sql).map((statement) => {
        const code = statement.code;
        let reason: string | undefined;
        if (
          /^\s*(BEGIN|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|START\s+TRANSACTION|PREPARE\s+TRANSACTION|SET\s+(?:LOCAL\s+|SESSION\s+)?(?:TRANSACTION|CHARACTERISTICS))\b/i.test(
            code,
          )
        ) {
          reason =
            "Transaction control is managed by Alchemy; DSQL permits one DDL statement per transaction and cannot combine DDL with bookkeeping.";
        } else if (
          /^\s*(?:CREATE|ALTER)\s+TABLE\b/i.test(code) &&
          /[\w$]+\s+(?:smallserial|serial|bigserial|serial2|serial4|serial8)\b/i.test(code)
        ) {
          reason =
            "Use a UUID primary key or a bigint identity with an explicit CACHE instead of serial.";
        } else if (/^\s*CREATE\s+SEQUENCE\b/i.test(code) || /\bAS\s+IDENTITY\b/i.test(code)) {
          const definitions = /^\s*CREATE\s+SEQUENCE\b/i.test(code)
            ? [code]
            : [...code.matchAll(/\bAS\s+IDENTITY\b(?:\s*\(([^)]*)\))?/gi)].map(
                (match) => match[1] ?? "",
              );
          if (
            definitions.some((definition) => {
              const cache = /\bCACHE\s+(\d+)\b/i.exec(definition)?.[1];
              return cache === undefined || (Number(cache) !== 1 && Number(cache) < 65536);
            })
          ) {
            reason =
              "DSQL sequences and identity columns require an explicit CACHE of 1 or at least 65536.";
          }
        }
        if (
          /^\s*ALTER\s+TABLE\b/i.test(code) &&
          /\bADD\s+(?!CONSTRAINT\b)(?:COLUMN\s+)?/i.test(code) &&
          /\b(?:DEFAULT|NOT\s+NULL|UNIQUE|CHECK|PRIMARY\s+KEY|REFERENCES|GENERATED)\b/i.test(code)
        ) {
          reason =
            "DSQL cannot add a column with a constraint or default. Add the column bare, then backfill it in a later statement.";
        }
        if (/^\s*(?:SET|RESET)\b/i.test(code)) {
          reason =
            "Session settings cannot be changed inside DSQL migration files. Qualify table names with their schema instead of changing search_path.";
        }
        const index = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.exec(code);
        if (index && /\bCONCURRENTLY\b/i.test(code)) {
          reason = "Use CREATE INDEX ASYNC instead of CONCURRENTLY on DSQL.";
        }
        if (reason)
          throw new Error(
            `Unsupported DSQL migration ${migration}: ${reason}\nStatement:\n${statement.sql.trim()}`,
          );
        let prepared = statement.sql;
        // Drizzle emits ordinary PostgreSQL CREATE INDEX ... USING btree.
        // DSQL's equivalent is CREATE INDEX ASYNC without the access method.
        if (index) {
          const using = /\bUSING\s+btree\b/i.exec(code);
          if (using)
            prepared =
              prepared.slice(0, using.index) + prepared.slice(using.index + using[0].length);
          if (!/^\s*ASYNC\b/i.test(code.slice(index[0].length))) {
            prepared =
              prepared.slice(0, index[0].length) + " ASYNC" + prepared.slice(index[0].length);
          }
        }
        return prepared.trim();
      }),
    catch: (cause) =>
      new MigrationError({
        message: `DSQL migration ${migration}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

/** Run before cluster mutation, and during diff when the directory resolves. */
export const validateDsqlMigrations = (
  input: NormalizedMigrationsInput,
  appliedHashes: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const hashes = yield* hashMigrations(input.dir).pipe(
      Effect.mapError(
        (cause) =>
          new MigrationError({
            message: `Failed to read DSQL migrations from ${input.dir}`,
            cause,
          }),
      ),
    );
    for (const [name, expected] of Object.entries(appliedHashes)) {
      if (hashes[name] !== expected) {
        return yield* new MigrationError({
          message: `Migration ${name} has changed since the last successful deploy. Expected SHA256: ${expected}; actual SHA256: ${hashes[name] ?? "file missing"}. Restore it and create a new migration instead.`,
        });
      }
    }
    const records = yield* readMigrationRecords(input.dir);
    for (const record of records) {
      yield* prepareDsqlStatements(record.sql, record.name);
    }
  });

/** Resolve a named index's table for checking an IF NOT EXISTS no-op. */
export const dsqlIndexTarget = (sql: string) => {
  const statement = parseDsqlStatements(sql)[0];
  if (!statement) return undefined;
  const prefix = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+ASYNC\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(
    statement.code,
  );
  if (!prefix) return undefined;
  const identifier = /^(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z_0-9$]*)/;
  const name = identifier.exec(statement.sql.slice(prefix[0].length))?.[0];
  if (!name) return undefined;
  const afterName = prefix[0].length + name.length;
  const on = /^\s+ON\s+(?:ONLY\s+)?/i.exec(statement.code.slice(afterName));
  if (!on) return undefined;
  const tableStart = afterName + on[0].length;
  let table = identifier.exec(statement.sql.slice(tableStart))?.[0];
  if (!table) return undefined;
  const dot = /^\s*\.\s*/.exec(statement.code.slice(tableStart + table.length));
  if (dot) {
    const next = identifier.exec(
      statement.sql.slice(tableStart + table.length + dot[0].length),
    )?.[0];
    if (!next) return undefined;
    table = `${table}${statement.sql.slice(tableStart + table.length, tableStart + table.length + dot[0].length)}${next}`;
  }
  if (!/^\s*\(/.test(statement.code.slice(tableStart + table.length))) return undefined;
  return {
    name: name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase(),
    table,
  };
};
