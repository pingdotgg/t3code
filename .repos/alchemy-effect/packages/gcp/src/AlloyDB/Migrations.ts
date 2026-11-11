import {
  makeStatementExecutor,
  MigrationError,
  migrationError,
  probeExecutor,
  rowsFromCells,
  runMigrations,
  type NormalizedMigrationsInput,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * AlloyDB `instances.executeSql` as a {@link SqlExecutor}. AlloyDB rolls
 * back every statement of a call when one fails, so each migration batch
 * is one atomic request.
 */
const makeDataApiExecutor = Effect.fn(function* (options: {
  instance: string;
  database: string;
  user: string;
  password: string;
}) {
  const executeSql = yield* alloydb.executeSqlProjectsLocationsClustersInstances;
  return makeStatementExecutor({
    dialect: "postgres",
    batch: "atomic",
    execute: (sqlStatement) =>
      executeSql({
        instance: options.instance,
        body: {
          database: options.database,
          user: options.user,
          password: options.password,
          sqlStatement,
        },
      }).pipe(
        Effect.mapError(migrationError(`executeSql on '${options.instance}'`)),
        // SQL errors come back inside a 200 response.
        Effect.flatMap((response) => {
          if (response.metadata?.status === "ERROR") {
            return Effect.fail(
              new MigrationError({
                message: `executeSql on '${options.instance}' failed: ${response.metadata.message ?? "unknown error"}`,
              }),
            );
          }
          const last = response.sqlResults?.at(-1);
          return Effect.succeed(rowsFromCells(last?.columns, last?.rows));
        }),
      ),
  });
});

/**
 * Apply migrations to a database on an AlloyDB primary instance through
 * the Data API. Call once the instance is ready.
 */
export const runInstanceMigrations = Effect.fn(function* (options: {
  instance: string;
  database: string;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
  user: string | undefined;
  password: string | Redacted.Redacted<string> | undefined;
}) {
  if (options.user === undefined || options.password === undefined) {
    return yield* new MigrationError({
      message: `Migrations on '${options.instance}' need credentials; set migrationsUser and migrationsPassword`,
    });
  }
  const executor = yield* makeDataApiExecutor({
    instance: options.instance,
    database: options.database,
    user: options.user,
    password: Redacted.isRedacted(options.password)
      ? Redacted.value(options.password)
      : options.password,
  });
  return yield* runMigrations({
    input: options.input,
    stamped: options.stamped,
    withExecutor: (apply) => probeExecutor(executor).pipe(Effect.flatMap(apply)),
  });
});
