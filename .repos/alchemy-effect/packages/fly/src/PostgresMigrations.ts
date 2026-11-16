import {
  MigrationError,
  runMigrations,
  withPgExecutor,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import { stripSslQueryParams } from "@alchemy.run/sql/PostgresDriver";
import { applySqlImports } from "@alchemy.run/sql/SqlFile";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export { stripSslQueryParams };

const TRANSIENT_CONNECT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
]);

const isTransientConnectError = (cause: unknown): boolean => {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && TRANSIENT_CONNECT_CODES.has(code);
};

/**
 * A verified-TLS `pg` session on a Fly Managed Postgres URI for the scope
 * of `use`. A fresh cluster's hostname takes a moment to resolve, so
 * connection failures are retried; one that persists is almost always a
 * missing route — MPG hostnames only exist on the org's private network.
 */
const withFlyPgExecutor = <A, E, R>(
  connectionUri: Redacted.Redacted<string>,
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
): Effect.Effect<A, MigrationError | E, R> =>
  withPgExecutor(
    {
      connectionString: connectionUri.pipe(Redacted.value, stripSslQueryParams),
      ssl: { rejectUnauthorized: true },
    },
    use,
    {
      retryConnect: { while: isTransientConnectError, times: 15, interval: "3 seconds" },
      onConnectFailure: (error) =>
        isTransientConnectError(error.cause)
          ? new MigrationError({
              message:
                `${error.message} — Fly Managed Postgres is only reachable ` +
                "on the org's private network. Run the deploy behind a " +
                "WireGuard peer or `fly mpg proxy`, or from a machine on " +
                "6PN. See https://fly.io/docs/mpg/create-and-connect/",
              cause: error.cause,
            })
          : error,
    },
  );

/**
 * Fly Managed Postgres's migration adaptation is the shared pipeline
 * with a connection-URI-scoped pg client as its executor. Use the
 * direct (non-PgBouncer) URI so DDL and advisory locks work.
 */
export const runPgMigrations = (options: {
  connectionUri: Redacted.Redacted<string>;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
}) =>
  runMigrations({
    input: options.input,
    stamped: options.stamped,
    withExecutor: (apply) => withFlyPgExecutor(options.connectionUri, apply),
  });

/** Run a single SQL script against the database (used for `importFiles`). */
export const runSql = (connectionUri: Redacted.Redacted<string>, sql: string) =>
  withFlyPgExecutor(connectionUri, (executor) => executor.query(sql)).pipe(Effect.asVoid);

/** Apply `importFiles`, each once and again only when it changes. */
export const runImports = (
  connectionUri: Redacted.Redacted<string>,
  importFiles: ReadonlyArray<string>,
  rootDir: string,
  previous: Record<string, string>,
) =>
  applySqlImports({
    importFiles,
    rootDir,
    previous,
    apply: (file) => runSql(connectionUri, file.sql),
  });
