/**
 * Wraps SQL execution callbacks with request encoding and result decoding.
 *
 * `SqlSchema` is a small adapter between Effect Schema and SQL statements. Each
 * helper builds a function that accepts the decoded request type used by
 * application code, encodes it before calling `execute`, and decodes unknown
 * driver rows into the result schema. The helpers differ only in how many rows
 * they expect and how they represent an empty result set.
 *
 * **Mental model**
 *
 * The request schema protects the boundary going into SQL, and the result
 * schema protects the boundary coming back out. `execute` still owns statement
 * construction and database execution; this module only shapes the values that
 * cross that boundary.
 *
 * **Common tasks**
 *
 * - Use {@link findAll} for queries that may return any number of rows.
 * - Use {@link findNonEmpty} when an empty result is a failure.
 * - Use {@link findOne} when the first row is required.
 * - Use {@link findOneOption} when the first row is optional.
 * - Use `void` for writes where the encoded request matters but the driver
 *   result should be discarded.
 *
 * **Gotchas**
 *
 * `execute` receives `Req["Encoded"]`, not `Req["Type"]`. Any schema
 * transformations, encoding services, nullable columns, JSON values, dates, and
 * bigint representations must match the SQL builder and dialect in use. Result
 * schemas decode rows after SQL client row transforms have run. {@link findOne}
 * and {@link findOneOption} only inspect the first returned row; they do not
 * assert that the query returned exactly one row.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import type * as Option from "../../Option.ts"
import * as Schema from "../../Schema.ts"

/**
 * Builds a query function that encodes the request and decodes all result rows,
 * allowing an empty result set.
 *
 * **When to use**
 *
 * Use when a query may return zero or more rows and an empty result should be
 * represented as an empty array.
 *
 * @see {@link findNonEmpty} for queries where an empty result is a failure
 *
 * @category constructors
 * @since 4.0.0
 */
export const findAll = <Req extends Schema.Top, Res extends Schema.Top, E, R>(
  options: {
    readonly Request: Req
    readonly Result: Res
    readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>
  }
) => {
  const encodeRequest = Schema.encodeEffect(options.Request)
  const decode = Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(options.Result)))
  return (
    request: Req["Type"]
  ): Effect.Effect<
    Array<Res["Type"]>,
    E | Schema.SchemaError,
    Req["EncodingServices"] | Res["DecodingServices"] | R
  > => Effect.flatMap(Effect.flatMap(encodeRequest(request), options.execute), decode)
}

/**
 * Builds a query function that encodes the request, decodes all result rows,
 * and fails with `NoSuchElementError` when the result set is empty.
 *
 * **When to use**
 *
 * Use when a query must return at least one row and an empty result should be
 * treated as a failure.
 *
 * @see {@link findAll} for queries where an empty result should return an empty array
 *
 * @category constructors
 * @since 4.0.0
 */
export const findNonEmpty = <Req extends Schema.Top, Res extends Schema.Top, E, R>(
  options: {
    readonly Request: Req
    readonly Result: Res
    readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>
  }
) => {
  const find = findAll(options)
  return (
    request: Req["Type"]
  ): Effect.Effect<
    Arr.NonEmptyArray<Res["Type"]>,
    E | Schema.SchemaError | Cause.NoSuchElementError,
    Req["EncodingServices"] | Res["DecodingServices"] | R
  > =>
    Effect.flatMap(find(request), (results) =>
      Arr.isArrayNonEmpty(results)
        ? Effect.succeed(results)
        : Effect.fail(new Cause.NoSuchElementError()))
}

const void_ = <Req extends Schema.Top, E, R>(
  options: {
    readonly Request: Req
    readonly execute: (request: Req["Encoded"]) => Effect.Effect<unknown, E, R>
  }
) => {
  const encode = Schema.encodeEffect(options.Request)
  return (request: Req["Type"]): Effect.Effect<void, E | Schema.SchemaError, R | Req["EncodingServices"]> =>
    Effect.asVoid(
      Effect.flatMap(encode(request), options.execute)
    )
}
export {
  /**
   * Runs a sql query with a request schema and discard the result.
   *
   * @category constructors
   * @since 4.0.0
   */
  void_ as void
}

/**
 * Builds a query function that encodes the request, decodes the first result
 * row, and fails with `NoSuchElementError` when no rows are returned.
 *
 * @category constructors
 * @since 4.0.0
 */
export const findOne = <Req extends Schema.Top, Res extends Schema.Top, E, R>(
  options: {
    readonly Request: Req
    readonly Result: Res
    readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>
  }
) => {
  const encodeRequest = Schema.encodeEffect(options.Request)
  const decode = Schema.decodeUnknownEffect(options.Result)
  return (
    request: Req["Type"]
  ): Effect.Effect<
    Res["Type"],
    E | Schema.SchemaError | Cause.NoSuchElementError,
    R | Req["EncodingServices"] | Res["DecodingServices"]
  > =>
    Effect.flatMap(
      Effect.flatMap(encodeRequest(request), options.execute),
      (arr): Effect.Effect<
        Res["Type"],
        Schema.SchemaError | Cause.NoSuchElementError,
        Req["EncodingServices"] | Res["DecodingServices"]
      > => Arr.isReadonlyArrayNonEmpty(arr) ? decode(arr[0]) : Effect.fail(new Cause.NoSuchElementError())
    )
}

/**
 * Builds a query function that encodes the request, decodes the first result row
 * as `Option.some`, and returns `Option.none` when no rows are returned.
 *
 * @category constructors
 * @since 4.0.0
 */
export const findOneOption = <Req extends Schema.Top, Res extends Schema.Top, E, R>(
  options: {
    readonly Request: Req
    readonly Result: Res
    readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>
  }
) => {
  const encodeRequest = Schema.encodeEffect(options.Request)
  const decode = Schema.decodeUnknownEffect(options.Result)
  return (
    request: Req["Type"]
  ): Effect.Effect<
    Option.Option<Res["Type"]>,
    E | Schema.SchemaError,
    R | Req["EncodingServices"] | Res["DecodingServices"]
  > =>
    Effect.flatMap(
      Effect.flatMap(encodeRequest(request), options.execute),
      (arr): Effect.Effect<
        Option.Option<Res["Type"]>,
        Schema.SchemaError,
        Req["EncodingServices"] | Res["DecodingServices"]
      > => Arr.isReadonlyArrayNonEmpty(arr) ? Effect.asSome(decode(arr[0])) : Effect.succeedNone
    )
}
