/**
 * Utilities for applying Effect SQL migrations to embedded PGlite databases.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations through the
 * current PGlite-backed `SqlClient`. It is typically used to bootstrap schemas
 * for local-first applications, browser or Node.js integration tests, examples,
 * and layer graphs that need an embedded PostgreSQL-compatible database to be
 * ready before dependent services start.
 *
 * Migrations are recorded in `effect_sql_migrations` by default and are loaded
 * using the shared `<id>_<name>` file or record-key convention. PGlite uses
 * PostgreSQL semantics inside the embedded database, so migrations run in a
 * transaction and the shared migrator uses PostgreSQL table locking to avoid
 * concurrent runners. Coordinate every process or layer using the same
 * `liveClient` or `dataDir`, and remember that in-memory PGlite clients start
 * with no recorded migrations. This adapter does not currently write schema
 * dumps for `schemaDirectory`; use PGlite data-directory persistence or
 * `PgliteClient.dumpDataDir` when a portable embedded database snapshot is
 * needed.
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
> = Migrator.make({})

/**
 * Creates a layer that runs the configured SQL migrations during layer construction.
 *
 * @category constructors
 * @since 4.0.0
 */
export const layer = <R>(
  options: Migrator.MigratorOptions<R>
): Layer.Layer<never, Migrator.MigrationError | SqlError, Client.SqlClient | R> => Layer.effectDiscard(run(options))
