import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Client } from "pg";
import { listSqlFiles, readSqlFile, type SqlFile } from "../../Sql/SqlFile.ts";

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

export const runPostgresMigrations = (
  target: PostgresMigrationTarget,
  migrationsDir: string,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const files = yield* listSqlFiles(migrationsDir);
    if (files.length > 0) {
      yield* applyPostgresMigrations({
        target,
        migrationsTable,
        migrationsFiles: files,
      });
    }
    const hashes: Record<string, string> = {};
    for (const file of files) hashes[file.id] = file.hash;
    return hashes;
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

interface ApplyMigrationsOptions {
  target: PostgresMigrationTarget;
  migrationsTable: string;
  migrationsFiles: ReadonlyArray<SqlFile>;
}

const applyPostgresMigrations = (options: ApplyMigrationsOptions) =>
  withPostgresClient(options.target, (client) =>
    Effect.gen(function* () {
      const table = quotePgIdentifier(options.migrationsTable);
      yield* pgExec(
        client,
        `CREATE TABLE IF NOT EXISTS ${table} (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );`,
      );

      const applied = yield* pgRows<{ name: string }>(
        client,
        `SELECT name FROM ${table};`,
      ).pipe(Effect.map((rows) => new Set(rows.map((row) => row.name))));
      let nextSeq = yield* getNextPgSeq(client, table);

      for (const file of options.migrationsFiles) {
        if (applied.has(file.id)) continue;
        const migrationId = nextSeq.toString().padStart(5, "0");
        nextSeq += 1;
        yield* Effect.gen(function* () {
          yield* pgExec(client, "BEGIN");
          yield* pgExec(client, file.sql);
          yield* pgExec(
            client,
            `INSERT INTO ${table} (id, name) VALUES ($1, $2);`,
            [migrationId, file.id],
          );
          yield* pgExec(client, "COMMIT");
        }).pipe(
          Effect.catch((error) =>
            pgExec(client, "ROLLBACK").pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
      }
    }),
  );

const runPostgresSql = (target: PostgresMigrationTarget, sql: string) =>
  withPostgresClient(target, (client) => pgExec(client, sql));

const getNextPgSeq = (client: Client, table: string) =>
  pgRows<{ id: string }>(client, `SELECT id FROM ${table};`).pipe(
    Effect.map((rows) => {
      let max = 0;
      for (const { id } of rows) {
        if (/^\d+$/.test(id)) {
          max = Math.max(max, Number.parseInt(id, 10));
        }
      }
      return max + 1;
    }),
  );

const withPostgresClient = <A, E, R>(
  target: PostgresMigrationTarget,
  use: (client: Client) => Effect.Effect<A, E, R>,
) =>
  withTemporaryPostgresRole(target, (role) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
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
      const created = yield* ops.createRole({
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
      ops
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
            schedule: Schedule.exponential("500 millis").pipe(
              Schedule.both(Schedule.recurs(5)),
            ),
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

const pgRows = <A>(client: Client, sql: string) =>
  Effect.tryPromise({
    try: () => client.query(sql).then((result) => result.rows as A[]),
    catch: toMigrationError,
  });

const toMigrationError = (cause: unknown) =>
  new PostgresMigrationError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const quotePgIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

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
