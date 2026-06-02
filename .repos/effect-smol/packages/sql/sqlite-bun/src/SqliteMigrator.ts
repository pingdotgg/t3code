/**
 * Utilities for applying Effect SQL migrations to Bun SQLite databases.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations through
 * the current Bun-backed SQLite `SqlClient`. It is typically used at
 * application startup, in deployment or setup scripts that prepare a local
 * SQLite file, in integration tests with temporary database files, or in layer
 * graphs that must install the schema before dependent services are acquired.
 *
 * Migrations are recorded in `effect_sql_migrations` by default and are loaded
 * using the shared `<id>_<name>` file or record-key convention. Only migrations
 * with an id greater than the latest recorded id are applied, so every client
 * involved in startup should point at the same SQLite filename and use a
 * writable Bun SQLite configuration. The Bun client enables WAL by default and
 * serializes access through a single `bun:sqlite` database handle, but separate
 * handles or processes can still contend for SQLite write locks. Bun's SQLite
 * driver runs statements synchronously, so large migration sets can block the
 * invoking runtime thread, and this adapter does not currently write SQLite
 * schema dumps for `schemaDirectory`.
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
 * Runs SQL migrations using the configured `SqlClient`, returning the migrations that were applied.
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
  //         Command.make("sqlite3", (sql as SqliteClient).config.filename, ...args),
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
 * Creates a layer that runs the configured SQL migrations during layer construction.
 *
 * @category constructors
 * @since 4.0.0
 */
export const layer = <R>(
  options: Migrator.MigratorOptions<R>
): Layer.Layer<
  never,
  SqlError | Migrator.MigrationError,
  Client.SqlClient | R
> => Layer.effectDiscard(run(options))
