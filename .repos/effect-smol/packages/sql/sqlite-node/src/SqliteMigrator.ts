/**
 * Migration runner for Node.js SQLite databases managed by Effect SQL.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides {@link run} and {@link layer} adapters that execute ordered
 * migrations through the current SQLite `SqlClient`. Use it during application
 * startup, in tests that create temporary database files, or in layer graphs
 * that must prepare a file-backed SQLite schema before dependent services are
 * acquired.
 *
 * ## Mental model
 *
 * Migrations are loaded using the shared `<id>_<name>` file or record-key
 * convention. Applied migrations are recorded in `effect_sql_migrations` by
 * default, and only migrations with an id greater than the latest recorded id
 * are executed. {@link layer} runs the same migration effect during layer
 * construction and provides no services of its own.
 *
 * ## Common tasks
 *
 * - Use {@link run} when startup code should decide where migration execution
 *   fits in the application workflow.
 * - Use {@link layer} when a layer graph should block dependent services until
 *   the SQLite schema is up to date.
 * - Use the re-exported shared `Migrator` loaders for file-system migrations or
 *   in-memory migration records.
 *
 * ## Gotchas
 *
 * Every client involved in startup should point at the same SQLite filename so
 * the recorded migration ids describe the database being used. Concurrent
 * writers can surface SQLite lock timeout errors, and this adapter does not
 * currently write SQLite schema dumps for `schemaDirectory`.
 *
 * @since 4.0.0
 */
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import type * as Client from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/**
 * @since 4.0.0
 */
export * from "effect/unstable/sql/Migrator"

/**
 * Runs SQL migrations for a SQLite database using the shared `Migrator` implementation and the current `SqlClient`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const run: <R2 = never>(
  options: Migrator.MigratorOptions<R2>
) => Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  Client.SqlClient | R2
> = Migrator.make({
  // dumpSchema(path, table) {
  //   const dump = (args: Array<string>) =>
  //     Effect.gen(function*() {
  //       const sql = yield* SqliteClient
  //       const dump = yield* pipe(
  //         Command.make("sqlite3", sql.config.filename, ...args),
  //         Command.string
  //       )
  //       return dump.replace(/^create table sqlite_sequence\(.*$/im, "")
  //         .replace(/\n{2,}/gm, "\n\n")
  //         .trim()
  //     }).pipe(
  //       Effect.mapError((error) => new Migrator.MigrationError({ kind: "Failed", message: error.message }))
  //     )
  //
  //   const dumpSchema = dump([".schema"])
  //
  //   const dumpMigrations = dump([
  //     "--cmd",
  //     `.mode insert ${table}`,
  //     `select * from ${table}`
  //   ])
  //
  //   const dumpAll = Effect.map(
  //     Effect.all([dumpSchema, dumpMigrations], { concurrency: 2 }),
  //     ([schema, migrations]) => schema + "\n\n" + migrations
  //   )
  //
  //   const dumpFile = (file: string) =>
  //     Effect.gen(function*() {
  //       const fs = yield* FileSystem
  //       const path = yield* Path
  //       const dump = yield* dumpAll
  //       yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  //       yield* fs.writeFileString(file, dump)
  //     }).pipe(
  //       Effect.mapError((error) => new Migrator.MigrationError({ kind: "Failed", message: error.message }))
  //     )
  //
  //   return dumpFile(path)
  // }
})

/**
 * Creates a layer that runs the configured SQLite migrations during layer construction and provides no services.
 *
 * @category constructors
 * @since 4.0.0
 */
export const layer = <R>(
  options: Migrator.MigratorOptions<R>
): Layer.Layer<
  never,
  Migrator.MigrationError | SqlError,
  Client.SqlClient | R
> => Layer.effectDiscard(run(options))
