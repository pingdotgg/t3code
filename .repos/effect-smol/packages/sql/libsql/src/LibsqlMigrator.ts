/**
 * libSQL migration support for Effect SQL applications.
 *
 * This module adapts the shared SQL migrator to libSQL and Turso databases. It
 * re-exports the common migration loaders and errors, then provides {@link run}
 * and {@link layer} helpers that apply pending migrations with the current
 * libSQL-backed `SqlClient`.
 *
 * **Mental model**
 *
 * Migrations are numbered operations loaded from files, records, or bundler
 * glob results. The runner ensures the migrations table exists, reads the
 * latest recorded id, and runs only migrations with a greater id through the
 * configured libSQL client.
 *
 * **Common tasks**
 *
 * Use {@link run} during application startup, deployment, or setup scripts when
 * migrations should be executed explicitly. Use {@link layer} in a layer graph
 * when dependent services should be acquired only after the schema is prepared.
 * Reuse the shared loaders from this module for file-based or in-memory
 * migration definitions.
 *
 * **Gotchas**
 *
 * libSQL uses SQLite-compatible SQL, so avoid dialect features unsupported by
 * libSQL or the configured Turso deployment. Remote Turso databases, local
 * `file:` databases, and embedded replicas can observe different state until
 * replication catches up. Run schema-changing migrations against the intended
 * writer, coordinate concurrent migrators, and do not rely on
 * `schemaDirectory` for libSQL schema dumps.
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
