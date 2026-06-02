/**
 * Typed metadata builders for Microsoft SQL Server stored procedure calls.
 *
 * This module defines the `Procedure` values consumed by `MssqlClient.call`.
 * Use it when application code invokes SQL Server stored procedures for
 * commands, reports, migrations, or workflows that need explicit Tedious
 * parameter metadata, output parameters, and typed result rows.
 *
 * **Mental model**
 *
 * A `Procedure` is a typed description, not an executable request. Start with
 * `make`, add input parameters with `param` and output parameters with
 * `outputParam`, optionally attach the expected row type with `withRows`, and
 * finish with `compile` to bind the input value record. `MssqlClient.call`
 * turns the compiled value into a Tedious request, registers output parameters,
 * and returns output values separately from returned rows.
 *
 * **Common tasks**
 *
 * Use `param<A>()` for every input parameter whose value should appear in the
 * record passed to `compile`, and `outputParam<A>()` for values collected from
 * SQL Server `returnValue` events. Use `withRows<A>()` when the procedure
 * returns a result set and callers should see a typed row array.
 *
 * **Gotchas**
 *
 * The generic type arguments are supplied explicitly; they are not inferred from
 * Tedious `DataType`s or `ParameterOptions`. Parameter names should match the
 * stored procedure parameter names used by Tedious, typically without a leading
 * `@`. `withRows` records only the expected TypeScript row type; runtime row
 * names and transforms still follow the configured `MssqlClient`.
 *
 * @since 4.0.0
 */
import { identity } from "effect/Function"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import type { Covariant } from "effect/Types"
import type { Row } from "effect/unstable/sql/SqlConnection"
import type { DataType } from "tedious/lib/data-type.ts"
import type { ParameterOptions } from "tedious/lib/request.ts"
import * as Parameter from "./Parameter.ts"

/**
 * Runtime type identifier used to mark SQL Server stored procedure definitions.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-mssql/Procedure"

/**
 * Type-level identifier used to mark SQL Server stored procedure definitions.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-mssql/Procedure"

/**
 * Pipeable definition of a SQL Server stored procedure, tracking its input parameters, output parameters, and result row type.
 *
 * @category models
 * @since 4.0.0
 */
export interface Procedure<
  I extends Record<string, Parameter.Parameter<any>>,
  O extends Record<string, Parameter.Parameter<any>>,
  A = never
> extends Pipeable {
  readonly [TypeId]: {
    readonly _A: Covariant<A>
  }
  readonly _tag: "Procedure"
  readonly name: string
  readonly params: I
  readonly outputParams: O
}

/**
 * Stored procedure definition with concrete input values bound for execution.
 *
 * @category models
 * @since 4.0.0
 */
export interface ProcedureWithValues<
  I extends Record<string, Parameter.Parameter<any>>,
  O extends Record<string, Parameter.Parameter<any>>,
  A
> extends Procedure<I, O, A> {
  readonly values: Procedure.ParametersRecord<I>
}

/**
 * Namespace containing type helpers and result types for SQL Server stored procedures.
 *
 * @since 4.0.0
 */
export declare namespace Procedure {
  /**
   * Maps a record of `Parameter` metadata to the corresponding record of parameter value types.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type ParametersRecord<
    A extends Record<string, Parameter.Parameter<any>>
  > =
    & {
      readonly [K in keyof A]: A[K] extends Parameter.Parameter<infer T> ? T
        : never
    }
    & {}

  /**
   * Result of a SQL Server stored procedure call, containing typed output parameter values and returned rows.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Result<
    O extends Record<string, Parameter.Parameter<any>>,
    A
  > {
    readonly output: ParametersRecord<O>
    readonly rows: ReadonlyArray<A>
  }
}

type Simplify<A> = { [K in keyof A]: A[K] } & {}

const procedureProto = {
  [TypeId]: {
    _A: identity
  },
  _tag: "Procedure",
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * Creates an empty SQL Server stored procedure definition for the given procedure name.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (name: string): Procedure<{}, {}> => {
  const procedure = Object.create(procedureProto)
  procedure.name = name
  procedure.params = {}
  procedure.outputParams = {}
  return procedure
}

/**
 * Adds a typed input parameter to a SQL Server stored procedure definition.
 *
 * @category combinator
 * @since 4.0.0
 */
export const param = <A>() =>
<N extends string, T extends DataType>(
  name: N,
  type: T,
  options?: ParameterOptions
) =>
<
  I extends Record<string, Parameter.Parameter<any>>,
  O extends Record<string, Parameter.Parameter<any>>
>(
  self: Procedure<I, O>
): Procedure<Simplify<I & { [K in N]: Parameter.Parameter<A> }>, O> => ({
  ...self,
  params: {
    ...self.params,
    [name]: Parameter.make(name, type, options)
  }
})

/**
 * Adds a typed output parameter to a SQL Server stored procedure definition.
 *
 * @category combinator
 * @since 4.0.0
 */
export const outputParam = <A>() =>
<N extends string, T extends DataType>(
  name: N,
  type: T,
  options?: ParameterOptions
) =>
<
  I extends Record<string, Parameter.Parameter<any>>,
  O extends Record<string, Parameter.Parameter<any>>
>(
  self: Procedure<I, O>
): Procedure<I, Simplify<O & { [K in N]: Parameter.Parameter<A> }>> => ({
  ...self,
  outputParams: {
    ...self.outputParams,
    [name]: Parameter.make(name, type, options)
  }
})

/**
 * Sets the expected row type for a SQL Server stored procedure definition.
 *
 * @category combinator
 * @since 4.0.0
 */
export const withRows = <A extends object = Row>() =>
<
  I extends Record<string, Parameter.Parameter<any>>,
  O extends Record<string, Parameter.Parameter<any>>
>(
  self: Procedure<I, O>
): Procedure<I, O, A> => self as any

/**
 * Binds input values to a SQL Server stored procedure definition, producing a value that can be executed with `MssqlClient.call`.
 *
 * @category combinator
 * @since 4.0.0
 */
export const compile = <
  I extends Record<string, Parameter.Parameter<any>>,
  O extends Record<string, Parameter.Parameter<any>>,
  A
>(
  self: Procedure<I, O, A>
) =>
(input: Procedure.ParametersRecord<I>): ProcedureWithValues<I, O, A> => ({
  ...self,
  values: input
})
