import {
  runMigrations,
  withMySqlExecutor,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import { applySqlImports, splitSqlStatements } from "@alchemy.run/sql/SqlFile";
import * as ps from "@distilled.cloud/planetscale";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const MIGRATION_PASSWORD_TTL_SECONDS = 600;

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
    withExecutor: (apply) => withMySQLExecutor(target, apply),
  });

/**
 * Apply `importFiles`, each once and again only when it changes. Vitess
 * rejects drizzle-kit's `--> statement-breakpoint` markers, so statements
 * run one at a time.
 */
export const runMySQLImports = (
  target: MySQLMigrationTarget,
  importFiles: ReadonlyArray<string>,
  rootDir: string,
  previous: Record<string, string>,
) =>
  applySqlImports({
    importFiles,
    rootDir,
    previous,
    apply: (file) =>
      withMySQLExecutor(target, (executor) =>
        Effect.forEach(splitSqlStatements(file.sql), (statement) => executor.query(statement), {
          discard: true,
        }),
      ),
  });

/** A verified-TLS `mysql2` session as a short-lived admin password. */
const withMySQLExecutor = <A, E, R>(
  target: MySQLMigrationTarget,
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
) =>
  withTemporaryMySQLPassword(target, (password) =>
    withMySqlExecutor(
      {
        host: password.host,
        user: password.username,
        password: Redacted.value(password.password),
        database: target.database,
        multipleStatements: true,
        ssl: { rejectUnauthorized: true },
      },
      use,
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
            schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(5)]),
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
