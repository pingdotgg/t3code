/**
 * Utilities for applying Effect SQL migrations to Microsoft SQL Server.
 *
 * This module re-exports the shared `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers for applying ordered migrations through
 * the current SQL Server `SqlClient`. It is typically used at application
 * startup, during deployment, in integration tests that provision temporary SQL
 * Server databases, or in layer graphs that need the database schema to be
 * current before dependent services are acquired.
 *
 * Applied migrations are stored in `effect_sql_migrations` by default and use
 * the shared `<id>_<name>` loader convention. Only migrations with ids greater
 * than the latest recorded id are run, so avoid inserting older migration ids
 * after a later migration has reached production. SQL Server migrations run
 * inside the shared migrator transaction and this adapter does not add a
 * dialect-specific table lock, so coordinate concurrent startup runners and
 * write T-SQL that is valid inside an explicit transaction. Remember that `GO`
 * is a client-side batch separator rather than a T-SQL statement, and split
 * migrations when SQL Server requires an object definition such as `CREATE
 * VIEW`, `CREATE PROCEDURE`, or `CREATE TRIGGER` to start its own batch. This
 * adapter also does not emit SQL Server schema dumps for `schemaDirectory`.
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
export const run: <R>(
  options: Migrator.MigratorOptions<R>
) => Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  SqlError | Migrator.MigrationError,
  Client.SqlClient | R
> = Migrator.make({})

/**
 * Creates a layer that runs the configured SQL migrations during layer construction.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <R>(
  options: Migrator.MigratorOptions<R>
): Layer.Layer<never, SqlError | Migrator.MigrationError, Client.SqlClient | R> => Layer.effectDiscard(run(options))
