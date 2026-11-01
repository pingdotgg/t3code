import * as ps from "@distilled.cloud/planetscale";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Connection } from "mysql2/promise";
import {
  makeMySQLMigrationExecutor,
  runMigrations,
  type NormalizedMigrationsInput,
  type StampedMigrationsState,
} from "../../SQL/Migrations/index.ts";
import { readSqlFile, splitSqlStatements } from "../../SQL/SqlFile.ts";

const MIGRATION_PASSWORD_TTL_SECONDS = 600;

// `mysql2` is an optional peer dependency — loaded lazily so importing the
// Planetscale provider never requires the driver unless migrations run.
const importMysql = () =>
  import("mysql2/promise").catch((cause) => {
    throw new Error(
      "Failed to load the 'mysql2' driver. Install the optional peer dependency 'mysql2' to run Planetscale MySQL migrations.",
      { cause },
    );
  });

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

/**
 * PlanetScale MySQL's migration adaptation is exactly this: the shared
 * pipeline with a temp-password-scoped mysql2 connection as its executor.
 */
export const runMySQLMigrations = (
  target: MySQLMigrationTarget,
  input: NormalizedMigrationsInput,
  stamped: StampedMigrationsState,
) =>
  runMigrations({
    input,
    stamped,
    withExecutor: (apply) =>
      withMySQLConnection(target, (connection) =>
        apply(makeMySQLMigrationExecutor(connection)),
      ),
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

const runMySQLSql = (target: MySQLMigrationTarget, sql: string) =>
  withMySQLConnection(target, (connection) =>
    Effect.gen(function* () {
      for (const statement of splitSqlStatements(sql)) {
        yield* mysqlQuery(connection, statement);
      }
    }),
  );

const withMySQLConnection = <A, E, R>(
  target: MySQLMigrationTarget,
  use: (connection: Connection) => Effect.Effect<A, E, R>,
) =>
  withTemporaryMySQLPassword(target, (password) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          const { createConnection } = await importMysql();
          return createConnection({
            host: password.host,
            user: password.username,
            password: Redacted.value(password.password),
            database: target.database,
            multipleStatements: true,
            ssl: { rejectUnauthorized: true },
          });
        },
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
      const created = yield* ps.createPassword({
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
      ps
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
            schedule: Schedule.max([
              Schedule.exponential("500 millis"),
              Schedule.recurs(5),
            ]),
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

const toMigrationError = (cause: unknown) =>
  new MySQLMigrationError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
