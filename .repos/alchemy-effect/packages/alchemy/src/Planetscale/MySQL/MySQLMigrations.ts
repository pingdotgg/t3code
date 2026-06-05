import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createConnection, type Connection } from "mysql2/promise";
import { listSqlFiles, readSqlFile, type SqlFile } from "../../Sql/SqlFile.ts";

const MIGRATION_PASSWORD_TTL_SECONDS = 600;

export class MySQLMigrationError extends Data.TaggedError(
  "Planetscale::MySQLMigrationError",
)<{
  message: string;
  cause?: unknown;
}> {}

export interface MySQLMigrationTarget {
  organization: string;
  database: string;
  branch: string;
}

export const runMySQLMigrations = (
  target: MySQLMigrationTarget,
  migrationsDir: string,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const files = yield* listSqlFiles(migrationsDir);
    if (files.length > 0) {
      yield* applyMySQLMigrations({
        target,
        migrationsTable,
        migrationsFiles: files,
      });
    }
    const hashes: Record<string, string> = {};
    for (const file of files) hashes[file.id] = file.hash;
    return hashes;
  });

export const runMySQLImports = (
  target: MySQLMigrationTarget,
  importFiles: ReadonlyArray<string>,
  rootDir: string,
  previous: Record<string, string>,
) =>
  Effect.gen(function* () {
    const hashes: Record<string, string> = { ...previous };
    for (const filePath of importFiles) {
      const file = yield* readSqlFile(rootDir, filePath);
      if (previous[filePath] === file.hash) {
        hashes[filePath] = file.hash;
        continue;
      }
      yield* runMySQLSql(target, file.sql);
      hashes[filePath] = file.hash;
    }
    const tracked = new Set(importFiles);
    for (const key of Object.keys(hashes)) {
      if (!tracked.has(key)) delete hashes[key];
    }
    return hashes;
  });

interface ApplyMigrationsOptions {
  target: MySQLMigrationTarget;
  migrationsTable: string;
  migrationsFiles: ReadonlyArray<SqlFile>;
}

const applyMySQLMigrations = (options: ApplyMigrationsOptions) =>
  withMySQLConnection(options.target, (connection) =>
    Effect.gen(function* () {
      const table = quoteMySQLIdentifier(options.migrationsTable);
      yield* mysqlQuery(
        connection,
        `CREATE TABLE IF NOT EXISTS ${table} (
           id varchar(255) NOT NULL PRIMARY KEY,
           name varchar(1024) NOT NULL,
           applied_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
         );`,
      );

      const applied = yield* mysqlQueryRows<{ name: string }>(
        connection,
        `SELECT name FROM ${table};`,
      ).pipe(Effect.map((rows) => new Set(rows.map((row) => row.name))));
      let nextSeq = yield* getNextMySQLSeq(connection, table);

      for (const file of options.migrationsFiles) {
        if (applied.has(file.id)) continue;
        const migrationId = nextSeq.toString().padStart(5, "0");
        nextSeq += 1;
        yield* Effect.gen(function* () {
          yield* mysqlQuery(connection, "START TRANSACTION");
          for (const statement of splitMySQLStatements(file.sql)) {
            yield* mysqlQuery(connection, statement);
          }
          yield* mysqlExecute(
            connection,
            `INSERT INTO ${table} (id, name) VALUES (?, ?);`,
            [migrationId, file.id],
          );
          yield* mysqlQuery(connection, "COMMIT");
        }).pipe(
          Effect.catch((error) =>
            mysqlQuery(connection, "ROLLBACK").pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
      }
    }),
  );

const runMySQLSql = (target: MySQLMigrationTarget, sql: string) =>
  withMySQLConnection(target, (connection) =>
    Effect.gen(function* () {
      for (const statement of splitMySQLStatements(sql)) {
        yield* mysqlQuery(connection, statement);
      }
    }),
  );

// Drizzle (and other migration tools) emit `--> statement-breakpoint` as a
// separator between statements. PlanetScale's Vitess parser rejects the `-->`
// token ("syntax error at position 2") because MySQL line comments require
// whitespace after `--`. Split on the marker and run each statement
// individually so the connector never sees the breakpoint comment.
const STATEMENT_BREAKPOINT = /\r?\n\s*-->\s*statement-breakpoint\s*\r?\n?/g;

const splitMySQLStatements = (sql: string): string[] =>
  sql
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const getNextMySQLSeq = (connection: Connection, table: string) =>
  mysqlQueryRows<{ id: string }>(connection, `SELECT id FROM ${table};`).pipe(
    Effect.map((rows) => {
      let max = 0;
      for (const { id } of rows) {
        if (/^\d+$/.test(String(id))) {
          max = Math.max(max, Number.parseInt(String(id), 10));
        }
      }
      return max + 1;
    }),
  );

const withMySQLConnection = <A, E, R>(
  target: MySQLMigrationTarget,
  use: (connection: Connection) => Effect.Effect<A, E, R>,
) =>
  withTemporaryMySQLPassword(target, (password) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () =>
          createConnection({
            host: password.host,
            user: password.username,
            password: Redacted.value(password.password),
            database: target.database,
            multipleStatements: true,
            ssl: { rejectUnauthorized: true },
          }),
        catch: toMigrationError,
      }),
      use,
      (connection) =>
        Effect.tryPromise({
          try: () => connection.end(),
          catch: toMigrationError,
        }).pipe(Effect.catch(() => Effect.void)),
    ),
  );

const withTemporaryMySQLPassword = <A, E, R>(
  target: MySQLMigrationTarget,
  use: (password: {
    id: string;
    host: string;
    username: string;
    password: Redacted.Redacted<string>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const created = yield* ops.createPassword({
        organization: target.organization,
        database: target.database,
        branch: target.branch,
        role: "admin",
        ttl: MIGRATION_PASSWORD_TTL_SECONDS,
      });

      return {
        id: created.id,
        host: created.access_host_url,
        username: created.username,
        password: created.plain_text,
      };
    }),
    use,
    (password) =>
      ops
        .deletePassword({
          organization: target.organization,
          database: target.database,
          branch: target.branch,
          id: password.id,
        })
        .pipe(
          // Already-deleted passwords are a success: nothing to clean up.
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            schedule: Schedule.exponential("500 millis").pipe(
              Schedule.both(Schedule.recurs(5)),
            ),
          }),
          // Migrations succeeded; don't fail the parent over a release-step
          // hiccup. The password's TTL bounds the orphan window; log loudly
          // so an operator can clean it up manually if needed.
          Effect.catch((cause: unknown) =>
            Effect.logWarning(
              `Failed to delete temporary Planetscale migration password after retries. ` +
                `It will expire via TTL (~${MIGRATION_PASSWORD_TTL_SECONDS}s). ` +
                `organization=${target.organization} database=${target.database} ` +
                `branch=${target.branch} id=${password.id}`,
              cause,
            ),
          ),
        ),
  );

const mysqlQuery = (connection: Connection, sql: string) =>
  Effect.tryPromise({
    try: () => connection.query(sql).then(() => undefined),
    catch: toMigrationError,
  });

const mysqlExecute = (
  connection: Connection,
  sql: string,
  values?: ReadonlyArray<string>,
) =>
  Effect.tryPromise({
    try: () =>
      connection
        .execute(sql, values ? [...values] : undefined)
        .then(() => undefined),
    catch: toMigrationError,
  });

const mysqlQueryRows = <A>(connection: Connection, sql: string) =>
  Effect.tryPromise({
    try: () => connection.query(sql).then(([rows]) => rows as A[]),
    catch: toMigrationError,
  });

const toMigrationError = (cause: unknown) =>
  new MySQLMigrationError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const quoteMySQLIdentifier = (identifier: string) =>
  `\`${identifier.replaceAll("`", "``")}\``;
