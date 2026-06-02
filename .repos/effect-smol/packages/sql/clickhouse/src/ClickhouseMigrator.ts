/**
 * ClickHouse adapter for the shared Effect SQL migration runner.
 *
 * This module re-exports the common `Migrator` loaders and error types, then
 * provides `run` and `layer` helpers that apply ordered migrations through the
 * current ClickHouse `SqlClient`. Use it during application startup,
 * deployment, or integration tests when analytical tables must exist before
 * dependent services start reading or writing data.
 *
 * **Mental model**
 *
 * Migrations are loaded with the shared `<id>_<name>` convention and recorded in
 * `effect_sql_migrations` by default. The runner reads the latest recorded id
 * and applies only migrations with larger ids, returning the ids and names that
 * were applied in the current run.
 *
 * **Common tasks**
 *
 * - Call `run` when an effect should explicitly migrate a ClickHouse database.
 * - Use `layer` when schema setup should happen while building a layer graph.
 * - Reuse the shared `Migrator` loaders from this module for file-based or
 *   in-memory migration definitions.
 *
 * **Gotchas**
 *
 * ClickHouse schema changes often depend on engine, `ORDER BY`, database, and
 * cluster settings. This adapter does not add a ClickHouse-specific table lock
 * or schema dumper, so coordinate concurrent migrators yourself and do not
 * expect `schemaDirectory` to write a ClickHouse schema snapshot.
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
 * Runs SQL migrations for ClickHouse using the supplied migrator options and
 * returns the applied migration IDs and names.
 *
 * @category constructors
 * @since 4.0.0
 */
export const run: <R2 = never>(
  { loader, schemaDirectory, table }: Migrator.MigratorOptions<R2>
) => Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  Client.SqlClient | R2
> = Migrator.make({})

/**
 * Creates a layer that runs the configured ClickHouse migrations during layer
 * construction and provides no services.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <R>(
  options: Migrator.MigratorOptions<R>
): Layer.Layer<
  never,
  Migrator.MigrationError | SqlError,
  Client.SqlClient | R
> => Layer.effectDiscard(run(options))
