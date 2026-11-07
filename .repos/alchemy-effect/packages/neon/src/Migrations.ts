import {
  runMigrations,
  withPgClient as withClient,
  withPgExecutor,
  type NormalizedMigrationsInput,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import { stripSslQueryParams } from "@alchemy.run/sql/PostgresDriver";
import { applySqlImports } from "@alchemy.run/sql/SqlFile";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Client, ClientConfig } from "pg";

/**
 * Neon's URIs carry `sslmode=require`; TLS is set on the client instead,
 * without verifying Neon's certificate chain.
 */
const clientConfig = (connectionUri: Redacted.Redacted<string>): ClientConfig => ({
  connectionString: connectionUri.pipe(Redacted.value, stripSslQueryParams),
  ssl: { rejectUnauthorized: false },
});

/** A `pg` client on a Neon connection URI for the scope of `use`. */
export const withPgClient = <A, E, R>(
  connectionUri: Redacted.Redacted<string>,
  use: (client: Client) => Effect.Effect<A, E, R>,
) => withClient(clientConfig(connectionUri), use);

/** Run one SQL script (several statements are fine). */
export const runSql = (connectionUri: Redacted.Redacted<string>, sql: string) =>
  withPgExecutor(clientConfig(connectionUri), (executor) => executor.query(sql)).pipe(
    Effect.asVoid,
  );

export const runPgMigrations = (options: {
  connectionUri: Redacted.Redacted<string>;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
}) =>
  runMigrations({
    input: options.input,
    stamped: options.stamped,
    withExecutor: (apply) => withPgExecutor(clientConfig(options.connectionUri), apply),
  });

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
