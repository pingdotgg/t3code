import type * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import {
  applyMigrations,
  inlineSqlParams,
  MigrationError,
  type SqlExecutor,
} from "alchemy/SQL/Migrations/index";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { database } from "./database.ts";

/** Rows of the last statement's result, keyed by column name. */
const rowsOf = (response: sqladmin.SqlInstancesExecuteSqlResponse) => {
  const result = response.results?.at(-1);
  const columns = (result?.columns ?? []).map((column) => column.name ?? "");
  return (result?.rows ?? []).map((row) =>
    Object.fromEntries(
      columns.map((name, index) => {
        const cell = row.values?.[index];
        return [name, cell?.nullValue ? null : (cell?.value ?? null)];
      }),
    ),
  );
};

/**
 * Applies the drizzle-kit migrations in `./migrations` through the Cloud
 * SQL Data API (`instances.executeSql`) at deploy time — no network path
 * from the deploying machine to the database is needed. Bookkeeping lives
 * in `__alchemy_migrations`, so each migration runs exactly once.
 *
 * The Data API logs in as a built-in user with a password read from a
 * regional Secret Manager secret, so the Action first makes sure the
 * secret's latest version is the user's password.
 */
export const migrate = Effect.gen(function* () {
  const { instance, db, user, password, passwordSecret, schema } =
    yield* database;

  const Migrate = Alchemy.Action(
    "Migrate",
    Effect.gen(function* () {
      const executeSql = yield* GCP.SQL.ExecuteSql(instance);
      const secret = yield* GCP.SecretManager.ReadWriteSecret(passwordSecret);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      return Effect.fn(function* (input: {
        password: Redacted.Redacted<string>;
        secretName: string;
        database: string;
        user: string;
        migrationsDir: string;
        snapshotHash: string;
      }) {
        const value = Redacted.value(input.password);
        if ((yield* secret.access()) !== value) {
          yield* secret.addVersion(value);
        }

        // The migrator's executor takes context-free effects; capture the
        // Action's runtime context once and provide it to each statement.
        const runtime = yield* RuntimeContext;
        const run = (sqlStatement: string) =>
          executeSql({
            body: {
              database: input.database,
              user: input.user,
              passwordSecretVersion: `${input.secretName}/versions/latest`,
              sqlStatement,
            },
          }).pipe(
            // A freshly created user can take a few seconds to accept logins.
            Effect.retry({
              schedule: Schedule.spaced("5 seconds"),
              times: 6,
            }),
            Effect.mapError(
              (cause) =>
                new MigrationError({
                  message: `executeSql failed: ${String(cause)}`,
                  cause,
                }),
            ),
            Effect.flatMap((response) =>
              response.status?.code
                ? Effect.fail(
                    new MigrationError({
                      message: `executeSql failed: ${response.status.message}`,
                    }),
                  )
                : Effect.succeed(response),
            ),
            Effect.provideService(RuntimeContext, runtime),
          );

        const executor: SqlExecutor = {
          dialect: "postgres",
          query: (sql, params) =>
            run(inlineSqlParams(sql, params ?? [], "postgres")).pipe(
              Effect.map(rowsOf),
            ),
          // One request, one transaction. drizzle-kit leaves the last
          // statement of a migration without its `;`.
          batch: (statements) =>
            run(
              [
                "BEGIN;",
                ...statements.map((statement) =>
                  statement.trim().endsWith(";")
                    ? statement.trim()
                    : `${statement.trim()};`,
                ),
                "COMMIT;",
              ].join("\n"),
            ).pipe(Effect.asVoid),
        };

        yield* applyMigrations({
          resolved: { dir: input.migrationsDir, table: "__alchemy_migrations" },
          executor,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        return input.snapshotHash;
      });
    }).pipe(
      Effect.provide([
        GCP.SQL.ExecuteSqlHttp,
        GCP.SecretManager.ReadWriteSecretHttp,
      ]),
    ),
  );

  return yield* Migrate({
    password: password.text,
    secretName: passwordSecret.name,
    database: db.databaseName,
    user: user.userName,
    migrationsDir: schema.out,
    snapshotHash: schema.snapshotHash,
  });
});
