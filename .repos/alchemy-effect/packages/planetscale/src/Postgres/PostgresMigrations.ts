import {
  runMigrations,
  withPgExecutor,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import { stripSslQueryParams } from "@alchemy.run/sql/PostgresDriver";
import { applySqlImports } from "@alchemy.run/sql/SqlFile";
import * as ps from "@distilled.cloud/planetscale";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const MIGRATION_ROLE_TTL_SECONDS = 600;

export interface PostgresMigrationTarget {
  organization: string;
  database: string;
  branch: string;
}

/**
 * PlanetScale Postgres's migration adaptation is exactly this: the shared
 * pipeline with a temp-role-scoped pg client as its executor.
 */
export const runPostgresMigrations = (
  target: PostgresMigrationTarget,
  input: NormalizedMigrationsInput,
  stamped: StampedMigrationsState,
) =>
  runMigrations({
    input,
    stamped,
    withExecutor: (apply) => withPostgresExecutor(target, apply),
  });

/** Apply `importFiles`, each once and again only when it changes. */
export const runPostgresImports = (
  target: PostgresMigrationTarget,
  importFiles: ReadonlyArray<string>,
  rootDir: string,
  previous: Record<string, string>,
) =>
  applySqlImports({
    importFiles,
    rootDir,
    previous,
    apply: (file) =>
      withPostgresExecutor(target, (executor) => executor.query(file.sql)).pipe(Effect.asVoid),
  });

/** A verified-TLS `pg` session as a short-lived migration role. */
const withPostgresExecutor = <A, E, R>(
  target: PostgresMigrationTarget,
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
) =>
  withTemporaryPostgresRole(target, (role) =>
    withPgExecutor(
      {
        connectionString: role.connectionUrl.pipe(Redacted.value, stripSslQueryParams),
        ssl: { rejectUnauthorized: true },
      },
      use,
    ),
  );

const withTemporaryPostgresRole = <A, E, R>(
  target: PostgresMigrationTarget,
  use: (role: { id: string; connectionUrl: Redacted.Redacted<string> }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const created = yield* ps.createRole({
        organization: target.organization,
        database: target.database,
        branch: target.branch,
        ttl: MIGRATION_ROLE_TTL_SECONDS,
        inherited_roles: ["postgres"],
      });

      const password = created.password!;
      const value = Redacted.value(password);
      const connectionUrl = yield* Effect.sync(
        () =>
          `postgresql://${encodeURIComponent(created.username)}:${encodeURIComponent(value)}@${created.access_host_url}:5432/${created.database_name}?sslmode=verify-full`,
      );
      return {
        id: created.id,
        connectionUrl: Redacted.make(connectionUrl),
      };
    }),
    use,
    (role) =>
      ps
        .deleteRole({
          organization: target.organization,
          database: target.database,
          branch: target.branch,
          id: role.id,
          successor: "postgres",
        })
        .pipe(
          // Already-deleted roles are a success: nothing to clean up.
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(5)]),
          }),
          // Migrations succeeded; don't fail the parent over a release-step
          // hiccup. The role's TTL bounds the orphan window; log loudly so
          // an operator can clean it up manually if needed.
          Effect.catch((cause: unknown) =>
            Effect.logWarning(
              `Failed to delete temporary Planetscale migration role after retries. ` +
                `It will expire via TTL (~${MIGRATION_ROLE_TTL_SECONDS}s). ` +
                `organization=${target.organization} database=${target.database} ` +
                `branch=${target.branch} id=${role.id}`,
              cause,
            ),
          ),
        ),
  );
