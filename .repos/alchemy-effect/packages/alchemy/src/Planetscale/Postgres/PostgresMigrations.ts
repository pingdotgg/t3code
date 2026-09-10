import * as ps from "@distilled.cloud/planetscale";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Client } from "pg";
import {
  makePgMigrationExecutor,
  runMigrations,
  type NormalizedMigrationsInput,
  type StampedMigrationsState,
} from "../../SQL/Migrations/index.ts";
import { readSqlFile } from "../../SQL/SqlFile.ts";

// `pg` is an optional peer dependency — loaded lazily so importing the
// Planetscale provider never requires the driver unless migrations run.
const importPg = () =>
  import("pg").catch((cause) => {
    throw new Error(
      "Failed to load the 'pg' driver. Install the optional peer dependency 'pg' to run Planetscale Postgres migrations.",
      { cause },
    );
  });

const MIGRATION_ROLE_TTL_SECONDS = 600;

export class PostgresMigrationError extends Data.TaggedError(
  "Planetscale::PostgresMigrationError",
)<{
  message: string;
  cause?: unknown;
}> {}

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
    withExecutor: (apply) =>
      withPostgresClient(target, (client) =>
        apply(makePgMigrationExecutor(client)),
      ),
  });

export const runPostgresImports = (
  target: PostgresMigrationTarget,
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
      yield* runPostgresSql(target, file.sql);
      hashes[filePath] = file.hash;
    }
    const tracked = new Set(importFiles);
    for (const key of Object.keys(hashes)) {
      if (!tracked.has(key)) delete hashes[key];
    }
    return hashes;
  });

const runPostgresSql = (target: PostgresMigrationTarget, sql: string) =>
  withPostgresClient(target, (client) => pgExec(client, sql));

const withPostgresClient = <A, E, R>(
  target: PostgresMigrationTarget,
  use: (client: Client) => Effect.Effect<A, E, R>,
) =>
  withTemporaryPostgresRole(target, (role) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const { Client } = yield* Effect.tryPromise({
          try: importPg,
          catch: toMigrationError,
        });
        const client = yield* Effect.sync(
          () =>
            new Client({
              connectionString: stripPgSslQueryParams(
                Redacted.value(role.connectionUrl),
              ),
              ssl: { rejectUnauthorized: true },
            }),
        );
        yield* Effect.tryPromise({
          try: () => client.connect(),
          catch: toMigrationError,
        });
        return client;
      }),
      use,
      (client) =>
        Effect.tryPromise({
          try: () => client.end(),
          catch: toMigrationError,
        }).pipe(Effect.catch(() => Effect.void)),
    ),
  );

const withTemporaryPostgresRole = <A, E, R>(
  target: PostgresMigrationTarget,
  use: (role: {
    id: string;
    connectionUrl: Redacted.Redacted<string>;
  }) => Effect.Effect<A, E, R>,
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
            schedule: Schedule.max([
              Schedule.exponential("500 millis"),
              Schedule.recurs(5),
            ]),
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

const pgExec = (client: Client, sql: string, values?: ReadonlyArray<unknown>) =>
  Effect.tryPromise({
    try: () =>
      client.query(sql, values as Array<unknown>).then(() => undefined),
    catch: toMigrationError,
  });

const toMigrationError = (cause: unknown) =>
  new PostgresMigrationError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const stripPgSslQueryParams = (uri: string): string => {
  try {
    const url = new URL(uri);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("channel_binding");
    return url.toString();
  } catch {
    return uri;
  }
};
