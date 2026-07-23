/**
 * PostgreSQL migration support for Effect SQL applications.
 *
 * This module adapts the shared SQL migrator to PostgreSQL. It re-exports the
 * common migration loaders and errors, then provides {@link run} and
 * {@link layer} helpers that execute pending migrations with the current
 * `SqlClient` and `PgClient`.
 *
 * **Mental model**
 *
 * Migrations are numbered operations loaded from files, records, or bundler
 * glob results. The migrator ensures the migrations table exists, reads the
 * latest recorded id, and runs only migrations with a greater id. PostgreSQL
 * runs use the configured `PgClient` connection details for both migration SQL
 * and optional schema dumps.
 *
 * **Common tasks**
 *
 * - Run migrations explicitly with {@link run} during startup or deployment
 * - Add migrations to a layer graph with {@link layer} so dependent services
 *   are acquired after the schema is prepared
 * - Reuse the shared loaders such as `fromGlob`, `fromRecord`, and
 *   `fromFileSystem`
 * - Enable `schemaDirectory` to write a portable schema snapshot after a
 *   successful migration run
 *
 * **Gotchas**
 *
 * - The default migrations table is `effect_sql_migrations`; use `table` when a
 *   database needs a different name
 * - Only migrations with an id greater than the latest recorded id are run, so
 *   editing an older migration does not make it run again
 * - Schema dumps shell out to `pg_dump`, so `pg_dump` must be on `PATH` and the
 *   layer must provide child process, filesystem, and path services
 * - Generated dumps intentionally omit comments, session settings, ownership,
 *   and privilege statements to keep snapshots portable
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as Migrator from "effect/unstable/sql/Migrator"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { PgClient } from "./PgClient.ts"

/**
 * @since 4.0.0
 */
export * from "effect/unstable/sql/Migrator"

/**
 * Runs PostgreSQL SQL migrations using the configured clients. Schema dumps use `pg_dump` and require child process, filesystem, and path services.
 *
 * @category constructors
 * @since 4.0.0
 */
export const run: <R2 = never>(
  options: Migrator.MigratorOptions<R2>
) => Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  | SqlClient
  | PgClient
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | R2
> = Migrator.make({
  dumpSchema(path, table) {
    const pgDump = (args: Array<string>) =>
      Effect.gen(function*() {
        const sql = yield* PgClient
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const dump = yield* ChildProcess.make("pg_dump", [...args, "--no-owner", "--no-privileges"], {
          env: {
            PATH: (globalThis as any).process?.env.PATH,
            PGHOST: sql.config.host,
            PGPORT: sql.config.port?.toString(),
            PGUSER: sql.config.username,
            PGPASSWORD: sql.config.password
              ? Redacted.value(sql.config.password)
              : undefined,
            PGDATABASE: sql.config.database,
            PGSSLMODE: sql.config.ssl ? "require" : "prefer"
          }
        }).pipe(spawner.string)

        return dump.replace(/^--.*$/gm, "")
          .replace(/^SET .*$/gm, "")
          .replace(/^SELECT pg_catalog\..*$/gm, "")
          .replace(/\n{2,}/gm, "\n\n")
          .trim()
      }).pipe(
        Effect.mapError((error) => new Migrator.MigrationError({ kind: "Failed", message: error.message }))
      )

    const pgDumpSchema = pgDump(["--schema-only"])

    const pgDumpMigrations = pgDump([
      "--column-inserts",
      "--data-only",
      `--table=${table}`
    ])

    const pgDumpAll = Effect.map(
      Effect.all([pgDumpSchema, pgDumpMigrations], { concurrency: 2 }),
      ([schema, migrations]) => schema + "\n\n" + migrations
    )

    const pgDumpFile = (path: string) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path_ = yield* Path.Path
        const dump = yield* pgDumpAll
        yield* fs.makeDirectory(path_.dirname(path), { recursive: true })
        yield* fs.writeFileString(path, dump)
      }).pipe(
        Effect.mapError((error) => new Migrator.MigrationError({ kind: "Failed", message: error.message }))
      )

    return pgDumpFile(path)
  }
})

/**
 * Creates a layer that runs PostgreSQL migrations during layer construction, including `pg_dump`-based schema dump support when requested.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <R>(
  options: Migrator.MigratorOptions<R>
): Layer.Layer<
  never,
  Migrator.MigrationError | SqlError,
  | SqlClient
  | PgClient
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | R
> => Layer.effectDiscard(run(options))
