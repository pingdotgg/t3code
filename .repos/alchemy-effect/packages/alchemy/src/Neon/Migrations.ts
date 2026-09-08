import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Client } from "pg";
import {
  makePgMigrationExecutor,
  runMigrations,
  type NormalizedMigrationsInput,
  type StampedMigrationsState,
} from "../SQL/Migrations/index.ts";
import { importPg } from "../SQL/PostgresDriver.ts";

export class PgError extends Data.TaggedError("PgError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Strip query-string SSL flags from a Neon connection URI. Neon's URIs
 * include `sslmode=require` and `channel_binding=require`, which trigger
 * a deprecation warning from `pg-connection-string`:
 *
 *   SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca'
 *   are treated as aliases for 'verify-full'.
 *
 * We control SSL programmatically via the `ssl` option below, so removing
 * the conflicting query params silences the warning without changing the
 * effective behavior.
 */
const stripSslQueryParams = (uri: string): string => {
  try {
    const url = new URL(uri);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("channel_binding");
    return url.toString();
  } catch {
    return uri;
  }
};

const toPgError = (cause: unknown) =>
  new PgError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** Open a pg client for the scope of `use`, closing it afterwards. */
export const withPgClient = <A, E, R>(
  connectionUri: Redacted.Redacted<string>,
  use: (client: Client) => Effect.Effect<A, E, R>,
): Effect.Effect<A, PgError | E, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        const { Client } = await importPg();
        const client = new Client({
          connectionString: stripSslQueryParams(Redacted.value(connectionUri)),
          ssl: { rejectUnauthorized: false },
        });
        await client.connect();
        return client;
      },
      catch: toPgError,
    }),
    use,
    (client) => Effect.promise(() => client.end().catch(() => {})),
  );

/**
 * Neon's migration adaptation is exactly this: the shared pipeline with a
 * connection-URI-scoped pg client as its executor.
 */
export const runPgMigrations = (options: {
  connectionUri: Redacted.Redacted<string>;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
}) =>
  runMigrations({
    ...options,
    withExecutor: (apply) =>
      withPgClient(options.connectionUri, (client) =>
        apply(makePgMigrationExecutor(client)),
      ),
  });

/**
 * Run a single SQL script against the database (used for `importFiles`).
 */
export const runSql = (connectionUri: Redacted.Redacted<string>, sql: string) =>
  withPgClient(connectionUri, (client) =>
    Effect.tryPromise({
      try: () => client.query(sql),
      catch: toPgError,
    }),
  ).pipe(Effect.asVoid);
