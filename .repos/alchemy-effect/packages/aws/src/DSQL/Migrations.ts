import {
  MigrationError,
  migrationError,
  quoteIdentifier,
  resolveMigrations,
  runMigrations,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
  withPgClient,
} from "@alchemy.run/sql/Migrations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Client } from "pg";
import { generateDbAuthToken } from "../Connection/DbAuthToken.ts";
import { dsqlIndexTarget, parseDsqlStatements, prepareDsqlStatements } from "./MigrationSql.ts";

const dsqlError = migrationError("DSQL migration");

/** Acquire a verified TLS connection using the deploy identity's admin token. */
export const withDsqlClient = <A, E, R>(
  endpoint: string,
  use: (client: Client) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const password = yield* generateDbAuthToken({
      service: "dsql",
      hostname: endpoint,
      action: "DbConnectAdmin",
    });
    return yield* withPgClient(
      {
        host: endpoint,
        port: 5432,
        user: "admin",
        database: "postgres",
        password: Redacted.value(password),
        ssl: { rejectUnauthorized: true },
        connectionTimeoutMillis: 10_000,
        // Client-side only: DSQL rejects a server-side `statement_timeout`.
        query_timeout: 35_000,
      },
      use,
    );
  });

/**
 * DSQL executes every statement in autocommit. A durable progress row records
 * completed statements, and a running row deliberately blocks replay after an
 * ambiguous disconnect. PostgreSQL ERROR responses confirm statement rollback;
 * those statements can be retried. Async jobs are persisted before polling.
 */
export const makeDsqlMigrationExecutor = (
  client: Pick<Client, "query">,
  table: string,
): SqlExecutor => {
  const progress = quoteIdentifier(`${table}__progress`, "postgres");
  const query: SqlExecutor["query"] = (sql, params) =>
    Effect.tryPromise({
      try: async () =>
        (await client.query(sql, [...(params ?? [])])).rows as Array<Record<string, unknown>>,
      catch: dsqlError,
    }).pipe(
      Effect.retry({
        while: (error) => sqlState(error.cause) === "40001",
        schedule: Schedule.max([Schedule.exponential("100 millis"), Schedule.recurs(5)]),
      }),
    );
  const batch: SqlExecutor["batch"] = (statements) =>
    Effect.forEach(statements, (sql) => query(sql), { discard: true });

  const waitForJob = (job: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 10; attempt++) {
        const [row] = yield* query("SELECT status, details FROM sys.jobs WHERE job_id = $1", [job]);
        if (row?.status === "completed") return;
        if (row?.status === "failed") {
          return yield* new MigrationError({
            message: `DSQL index job ${job} failed: ${row.details as string}. Drop the invalid index and repair the migration progress before retrying.`,
          });
        }
        if (!row)
          return yield* new MigrationError({
            message: `DSQL index job ${job} is no longer available. Verify the index and repair the migration progress before retrying.`,
          });
        if (attempt < 9) yield* Effect.sleep("5 seconds");
      }
      return yield* new MigrationError({
        message: `DSQL index job ${job} is still running after 45 seconds. Retry the deploy to continue waiting.`,
      });
    });

  return {
    dialect: "postgres",
    migrationTableId: "uuid",
    transactionalDdl: false,
    query,
    batch,
    applyMigration: (record, bookkeeping) =>
      Effect.gen(function* () {
        const statements = [
          ...(yield* prepareDsqlStatements(record.sql, record.name)),
          bookkeeping,
        ];
        yield* query(`CREATE TABLE IF NOT EXISTS ${progress} (
        name text PRIMARY KEY, hash text NOT NULL,
        next_statement integer NOT NULL, status text NOT NULL, job_id text
      )`);
        let [state] = yield* query(
          `SELECT hash, next_statement, status, job_id FROM ${progress} WHERE name = $1`,
          [record.name],
        );
        if (!state) {
          yield* query(
            `INSERT INTO ${progress} (name, hash, next_statement, status) VALUES ($1, $2, 0, 'ready')`,
            [record.name, record.hash],
          );
          state = { hash: record.hash, next_statement: 0, status: "ready" };
        }
        if (state.hash !== record.hash) {
          return yield* new MigrationError({
            message: `DSQL migration ${record.name} changed after it started. Restore the original file (SHA256 ${state.hash as string}); actual SHA256: ${record.hash}.`,
          });
        }
        const nextStatement = Number(state.next_statement);
        if (
          !Number.isSafeInteger(nextStatement) ||
          nextStatement < 0 ||
          nextStatement >= statements.length ||
          !["ready", "running", "waiting"].includes(String(state.status)) ||
          (state.status === "waiting" && typeof state.job_id !== "string")
        ) {
          return yield* new MigrationError({
            message: `DSQL migration ${record.name} has inconsistent progress in ${progress}. Inspect and repair its history before deploying.`,
          });
        }
        if (state.status === "running") {
          return yield* new MigrationError({
            message: `DSQL migration ${record.name}, statement ${Number(state.next_statement) + 1} has an uncertain outcome. Inspect the database before repairing ${progress}; Alchemy will not replay it automatically.`,
          });
        }
        for (let index = Number(state.next_statement); index < statements.length; index++) {
          if (state.status === "waiting" && state.job_id) {
            yield* waitForJob(state.job_id as string);
          } else {
            yield* query(
              `UPDATE ${progress} SET status = 'running', job_id = NULL WHERE name = $1`,
              [record.name],
            );
            const rows = yield* query(statements[index]).pipe(
              Effect.catchTag("MigrationError", (error) =>
                // ERROR is a server-confirmed failed autocommit statement. A
                // socket error/timeout has no such assurance: leave it running.
                serverRejected(error.cause)
                  ? query(`UPDATE ${progress} SET status = 'ready' WHERE name = $1`, [
                      record.name,
                    ]).pipe(Effect.andThen(Effect.fail(error)))
                  : Effect.fail(error),
              ),
            );
            const isIndex = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+ASYNC\b/i.test(
              parseDsqlStatements(statements[index])[0]?.code ?? "",
            );
            const job = isIndex ? rows[0]?.job_id : undefined;
            if (isIndex && job === undefined) {
              const target = dsqlIndexTarget(statements[index]);
              const existing = target
                ? yield* query(
                    `SELECT i.indisvalid FROM pg_index i
                 JOIN pg_class c ON c.oid = i.indexrelid
                 WHERE c.relname = $1 AND i.indrelid = to_regclass($2)`,
                    [target.name, target.table],
                  )
                : [];
              if (existing[0]?.indisvalid !== true) {
                return yield* new MigrationError({
                  message: `DSQL index statement in ${record.name} returned no job ID and the index could not be verified as valid. Inspect the existing index before advancing the progress row in ${progress}.`,
                });
              }
            }
            if (job !== undefined) {
              yield* query(
                `UPDATE ${progress} SET status = 'waiting', job_id = $2 WHERE name = $1`,
                [record.name, job],
              );
              yield* waitForJob(job as string);
            }
          }
          yield* query(
            `UPDATE ${progress} SET next_statement = $2, status = 'ready', job_id = NULL WHERE name = $1`,
            [record.name, index + 1],
          );
          state.status = "ready";
        }
      }),
  };
};

const sqlState = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
const serverRejected = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "severity" in cause &&
  cause.severity === "ERROR" &&
  typeof sqlState(cause) === "string";

/**
 * One cluster-wide durable mutex serializes migrators even across different
 * migration table names. It has no lease: a crashed owner must be inspected
 * before its lock is removed, so a slow DDL cannot outlive a stolen lease.
 */
export const withDsqlMigrationLock = <A, E, R>(
  executor: SqlExecutor,
  use: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const owner = crypto.randomUUID();
    yield* executor.query(
      `CREATE TABLE IF NOT EXISTS "__alchemy_dsql_migration_lock" (id integer PRIMARY KEY, owner uuid NOT NULL)`,
    );
    yield* executor
      .query(`INSERT INTO "__alchemy_dsql_migration_lock" (id, owner) VALUES (1, $1)`, [owner])
      .pipe(
        Effect.mapError(
          (cause) =>
            new MigrationError({
              message:
                "Could not acquire the DSQL migration lock. Another deploy may be active. After a crashed deploy, inspect migration progress and confirm the old process stopped before deleting the row in __alchemy_dsql_migration_lock.",
              cause,
            }),
        ),
      );
    const result = yield* Effect.result(use);
    // A failed release is surfaced; a retained lock must never look successful.
    yield* executor.query(
      `DELETE FROM "__alchemy_dsql_migration_lock" WHERE id = 1 AND owner = $1`,
      [owner],
    );
    return yield* Effect.fromResult(result);
  }).pipe(Effect.uninterruptible);

export const runDsqlMigrations = (options: {
  endpoint: string;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
}) =>
  runMigrations({
    ...options,
    withExecutor: (apply) =>
      withDsqlClient(options.endpoint, (client) => {
        const table = resolveMigrations(options).table;
        if (new TextEncoder().encode(`${table}__progress`).length > 63) {
          return Effect.fail(
            new MigrationError({
              message:
                "DSQL migration table names must leave room for the __progress suffix within PostgreSQL's 63-byte identifier limit.",
            }),
          );
        }
        const executor = makeDsqlMigrationExecutor(client, table);
        return withDsqlMigrationLock(executor, apply(executor));
      }),
  });
