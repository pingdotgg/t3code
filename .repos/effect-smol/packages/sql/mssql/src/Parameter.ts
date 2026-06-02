/**
 * Typed SQL Server stored procedure parameter metadata.
 *
 * This module builds {@link Parameter} values that pair a stored procedure
 * parameter name with a Tedious `DataType`, Tedious `ParameterOptions`, and a
 * phantom TypeScript value type. `Procedure.param` and
 * `Procedure.outputParam` use this metadata, and `MssqlClient.call` forwards it
 * to Tedious when registering input and output parameters.
 *
 * **Mental model**
 *
 * A `Parameter<A>` describes how Tedious should bind a value; it is not the
 * value itself. The `A` type guides the record accepted by
 * `Procedure.compile`, while Tedious validates and encodes the runtime value
 * when the request is executed.
 *
 * **Common tasks**
 *
 * - Annotate inputs that need explicit SQL Server data types, sizes, precision,
 *   scale, or table-valued parameter options.
 * - Define output parameters so `MssqlClient.call` can collect returned values
 *   by name.
 * - Reuse the same metadata shape from direct `make` calls and the `Procedure`
 *   builders.
 *
 * **Gotchas**
 *
 * Names should match the stored procedure parameter name expected by Tedious,
 * normally without a leading `@`. Table-valued parameter values must use
 * Tedious' table shape with `name`, optional `schema`, `columns`, and `rows`.
 * Output parameters are registered without an initial value, so input-output
 * parameters need explicit modeling instead of assuming compiled input values
 * are reused.
 *
 * @see {@link make} for constructing parameter metadata directly.
 *
 * @since 4.0.0
 */
import { identity } from "effect/Function"
import type { DataType } from "tedious/lib/data-type.ts"
import type { ParameterOptions } from "tedious/lib/request.ts"

/**
 * Runtime type identifier used to mark SQL Server stored procedure parameter metadata.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-mssql/Parameter"

/**
 * Type-level identifier used to mark SQL Server stored procedure parameter metadata.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-mssql/Parameter"

/**
 * Metadata for a SQL Server stored procedure parameter, including its name, Tedious data type, options, and phantom value type.
 *
 * @category models
 * @since 4.0.0
 */
export interface Parameter<out A> {
  readonly [TypeId]: (_: never) => A
  readonly _tag: "Parameter"
  readonly name: string
  readonly type: DataType
  readonly options: ParameterOptions
}

/**
 * Creates typed metadata for a SQL Server stored procedure parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <A>(
  name: string,
  type: DataType,
  options: ParameterOptions = {}
): Parameter<A> => ({
  [TypeId]: identity,
  _tag: "Parameter",
  name,
  type,
  options
})
