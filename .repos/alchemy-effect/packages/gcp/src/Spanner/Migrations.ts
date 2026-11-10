import * as crypto from "node:crypto";
import {
  MigrationError,
  migrationError,
  runMigrations,
  splitSqlScript,
  type MigrationRecord,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { waitForOperation } from "../Operation.ts";

/**
 * Spanner names must start with a letter, so the bookkeeping table drops
 * the default `__alchemy_migrations` prefix.
 */
export const SPANNER_MIGRATIONS_TABLE = "alchemy_migrations";

type SpannerDialect = "googlesql" | "postgres";

const DDL = /^(?:CREATE|ALTER|DROP|RENAME|GRANT|REVOKE|ANALYZE)\b/i;

/** Consecutive statements of one kind: DDL goes to `updateDdl`, DML to a transaction. */
const groupStatements = (statements: ReadonlyArray<string>) => {
  const groups: Array<{ ddl: boolean; statements: string[] }> = [];
  for (const statement of statements) {
    const ddl = DDL.test(statement);
    const last = groups.at(-1);
    if (last && last.ddl === ddl) last.statements.push(statement);
    else groups.push({ ddl, statements: [statement] });
  }
  return groups;
};

/** Attempts per DDL statement whose earlier operations failed. */
const MAX_DDL_ATTEMPTS = 20;

/**
 * Spanner as a {@link SqlExecutor} over one session. Spanner cannot commit
 * DDL with DML, so DDL runs as `updateDdl` operations and each migration's
 * trailing DML commits in one transaction with its bookkeeping row.
 *
 * A migration's DDL runs one statement per operation, named after the
 * migration, the statement's position, and its text. A deploy after a
 * crash finds the operations it already started and waits for them
 * instead of rerunning their statements; after a failed statement is
 * fixed, the statements before it are found applied and only the fixed
 * one runs.
 */
const makeSpannerExecutor = Effect.fn(function* (options: {
  database: string;
  dialect: SpannerDialect;
  session: string;
}) {
  const { database, dialect, session } = options;
  const executeSql = yield* spanner.executeSqlProjectsInstancesDatabasesSessions;
  const executeBatchDml = yield* spanner.executeBatchDmlProjectsInstancesDatabasesSessions;
  const commit = yield* spanner.commitProjectsInstancesDatabasesSessions;
  const updateDdl = yield* spanner.updateDdlProjectsInstancesDatabases;
  const getOperation = yield* spanner.getProjectsInstancesDatabasesOperations;

  const awaitDdl = (operation: spanner.Operation) =>
    waitForOperation(operation, (name) => getOperation({ name }), {
      budget: "30 minutes",
      interval: "2 seconds",
    }).pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        cause._tag === "GCP.OperationFailed"
          ? new MigrationError({
              message: `Spanner DDL on ${database} failed: ${cause.message}`,
              cause,
            })
          : migrationError(`Spanner DDL on ${database}`)(cause),
      ),
    );

  const runDdl = (statements: ReadonlyArray<string>) =>
    updateDdl({ database, body: { statements: [...statements] } }).pipe(
      Effect.mapError(migrationError(`Spanner DDL on ${database}`)),
      Effect.flatMap(awaitDdl),
    );

  /**
   * Run one DDL statement exactly once under deterministic operation ids
   * `{base}_0`, `{base}_1`, …: an operation a previous deploy started is
   * awaited, not resubmitted. A single statement applies atomically, so an
   * earlier attempt that failed changed nothing and the next attempt id
   * runs it again; a failure of this deploy's own attempt fails the deploy.
   */
  const runDdlOnce = (statement: string, base: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < MAX_DDL_ATTEMPTS; attempt++) {
        const operationId = `${base}_${attempt}`;
        const submitted = yield* updateDdl({
          database,
          body: { statements: [statement], operationId },
        }).pipe(
          Effect.map((operation) => ({ operation, replayed: false })),
          Effect.catchTag("DdlOperationIdExists", () =>
            getOperation({ name: `${database}/operations/${operationId}` }).pipe(
              Effect.map((operation) => ({ operation, replayed: true })),
            ),
          ),
          Effect.mapError(migrationError(`Spanner DDL on ${database}`)),
        );
        const outcome = yield* Effect.result(awaitDdl(submitted.operation));
        if (Result.isSuccess(outcome)) return;
        if (!submitted.replayed) return yield* outcome.failure;
      }
      return yield* new MigrationError({
        message: `Spanner DDL on ${database} failed ${MAX_DDL_ATTEMPTS} times: ${statement}`,
      });
    });

  const runDml = (statements: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const result = yield* executeBatchDml({
        session,
        body: {
          transaction: { begin: { readWrite: {} } },
          seqno: "1",
          statements: statements.map((sql) => ({ sql })),
        },
      }).pipe(Effect.mapError(migrationError(`Spanner DML on ${database}`)));
      if (result.status?.code) {
        return yield* new MigrationError({
          message: `Spanner DML on ${database} failed: ${result.status.message ?? `code ${result.status.code}`}`,
        });
      }
      const transactionId = result.resultSets?.[0]?.metadata?.transaction?.id;
      if (!transactionId) {
        return yield* new MigrationError({
          message: `Spanner returned no transaction for DML on ${database}`,
        });
      }
      yield* commit({ session, body: { transactionId } }).pipe(
        Effect.mapError(migrationError(`Committing DML on ${database}`)),
      );
    });

  const splitAll = (statements: ReadonlyArray<string>) =>
    statements.flatMap((statement) => splitSqlScript(statement, dialect));

  const runGroups = (statements: ReadonlyArray<string>) =>
    Effect.forEach(
      groupStatements(splitAll(statements)),
      (group) => (group.ddl ? runDdl(group.statements) : runDml(group.statements)),
      { discard: true },
    );

  const operationBaseOf = (record: MigrationRecord, index: number, statement: string) =>
    Effect.sync(
      () =>
        `alchemy_${crypto.createHash("sha256").update(`${record.name}\n${index}\n${statement}`).digest("hex").slice(0, 32)}`,
    );

  return {
    dialect,
    transactionalDdl: false,
    ...(dialect === "postgres"
      ? { migrationTableId: "spanner" as const, defaultSchema: "public" }
      : {}),
    query: (sql) =>
      executeSql({ session, body: { sql: splitAll([sql])[0] ?? sql } }).pipe(
        Effect.mapError(migrationError(`Spanner query on ${database}`)),
        Effect.map((result) => {
          const fields = (result.metadata?.rowType?.fields ?? []).map((field) => field.name ?? "");
          return (result.rows ?? []).map((row) =>
            Object.fromEntries(
              fields.map((name, index) => [name, (row as ReadonlyArray<unknown>)[index] ?? null]),
            ),
          );
        }),
      ),
    batch: runGroups,
    applyMigration: (record, bookkeeping) =>
      Effect.gen(function* () {
        const groups = groupStatements(splitAll(record.statements));
        const dml = groups.findIndex((group) => !group.ddl);
        if (dml >= 0 && dml < groups.length - 1) {
          return yield* new MigrationError({
            message: `Spanner migration ${record.name} runs DML between DDL statements. Spanner can't commit DDL and DML together, so put the DML after the migration's DDL or in its own migration.`,
          });
        }
        let index = 0;
        for (const group of groups) {
          if (!group.ddl) continue;
          for (const statement of group.statements) {
            yield* runDdlOnce(statement, yield* operationBaseOf(record, index++, statement));
          }
        }
        // The trailing DML commits with the bookkeeping row: exactly once.
        const trailing = groups.at(-1);
        yield* runDml([...(trailing && !trailing.ddl ? trailing.statements : []), bookkeeping]);
      }),
  } satisfies SqlExecutor;
});

/**
 * Apply migrations to a Spanner database. Call once the database is ready.
 */
export const runDatabaseMigrations = Effect.fn(function* (options: {
  database: string;
  dialect: SpannerDialect;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
}) {
  const createSession = yield* spanner.createProjectsInstancesDatabasesSessions;
  const deleteSession = yield* spanner.deleteProjectsInstancesDatabasesSessions;
  return yield* runMigrations({
    input: { ...options.input, table: options.input.table ?? SPANNER_MIGRATIONS_TABLE },
    stamped: options.stamped,
    withExecutor: (apply) =>
      Effect.acquireUseRelease(
        createSession({ database: options.database, body: {} }).pipe(
          Effect.mapError(migrationError(`Opening a session on ${options.database}`)),
        ),
        (session) =>
          makeSpannerExecutor({
            database: options.database,
            dialect: options.dialect,
            session: session.name ?? "",
          }).pipe(Effect.flatMap(apply)),
        (session) => deleteSession({ name: session.name ?? "" }).pipe(Effect.ignore),
      ),
  });
});
