/**
 * Defines the low-level SQL connection service and shared row/acquirer types
 * used by Effect's unstable SQL driver integrations.
 *
 * A `Connection` is the driver-facing layer underneath `SqlClient`: it executes
 * already-compiled SQL with positional parameters and exposes transformed row
 * results, raw driver results, streams, value arrays, and unprepared statement
 * execution. Most applications should work through `SqlClient`, while driver
 * integrations and advanced code use this module to provide scoped connection
 * acquisition, implement pooling, reserve a connection for a workflow, or adapt
 * a dialect-specific client into Effect.
 *
 * Connections are resources and should be acquired through an `Acquirer` in a
 * `Scope` so pool checkout, transaction pinning, and release semantics are
 * preserved. Transaction coordination lives at the `SqlClient` layer, so mixing
 * manually reserved connections with transactional client queries can bypass the
 * expected atomic boundary. Raw, unprepared, streaming, parameter, and row
 * transformation behavior ultimately comes from the driver and dialect; check
 * each integration for differences in placeholders, prepared statement support,
 * cursor lifetime, and result shapes.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import type { Effect } from "../../Effect.ts"
import type { Scope } from "../../Scope.ts"
import type { Stream } from "../../Stream.ts"
import type { SqlError } from "./SqlError.ts"

/**
 * Low-level SQL driver connection capable of executing compiled SQL as
 * transformed rows, raw results, streams, value arrays, or unprepared
 * statements.
 *
 * @category models
 * @since 4.0.0
 */
export interface Connection {
  readonly execute: (
    sql: string,
    params: ReadonlyArray<unknown>,
    transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
  ) => Effect<ReadonlyArray<any>, SqlError>

  /**
   * Execute the specified SQL query and return the raw results directly from
   * underlying SQL client.
   */
  readonly executeRaw: (
    sql: string,
    params: ReadonlyArray<unknown>
  ) => Effect<unknown, SqlError>

  readonly executeStream: (
    sql: string,
    params: ReadonlyArray<unknown>,
    transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
  ) => Stream<any, SqlError>

  readonly executeValues: (
    sql: string,
    params: ReadonlyArray<unknown>
  ) => Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>

  readonly executeUnprepared: (
    sql: string,
    params: ReadonlyArray<unknown>,
    transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
  ) => Effect<ReadonlyArray<any>, SqlError>
}

/**
 * Scoped effect that acquires a `Connection`, may fail with `SqlError`, and
 * requires a `Scope` for release.
 *
 * @category models
 * @since 4.0.0
 */
export type Acquirer = Effect<Connection, SqlError, Scope>

/**
 * Service tag for a low-level SQL `Connection`.
 *
 * @category tag
 * @since 4.0.0
 */
export const Connection = Context.Service<Connection>("effect/sql/SqlConnection")

/**
 * Generic SQL row shape mapping column names to unknown values.
 *
 * @category models
 * @since 4.0.0
 */
export type Row = { readonly [column: string]: unknown }
