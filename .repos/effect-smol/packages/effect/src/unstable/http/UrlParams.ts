/**
 * Immutable URL query parameters represented as ordered string pairs.
 *
 * This module is the shared query-parameter model for HTTP client request
 * queries, URL-encoded form bodies, and server-side decoding. A `UrlParams`
 * value can be built from records, iterables, or native `URLSearchParams`, then
 * inspected, appended, replaced, removed, serialized, converted to a `URL`, or
 * decoded with schemas.
 *
 * **Mental model**
 *
 * The core representation is a list of `[key, value]` string pairs. Duplicate
 * keys and pair order are preserved by `make`, `fromInput`, iteration, and
 * append-style operations. Record input is a convenience layer: primitive values
 * become strings, arrays become repeated parameters, nested records use bracket
 * notation, and `undefined` fields are skipped.
 *
 * **Common tasks**
 *
 * - Build query parameters from plain records, tuples, or `URLSearchParams`.
 * - Read the first, last, or all values for a key.
 * - Replace, append, transform, or remove keys without mutating the original.
 * - Serialize a query string, merge parameters into a URL, or decode records and
 *   JSON fields with schemas.
 *
 * **Gotchas**
 *
 * Use `getAll` when every duplicate value matters. `set` and `setAll` replace
 * existing values for matching keys, while `append` and `appendAll` preserve
 * them. Serialization through `toString` and `makeUrl` delegates to the platform
 * `URLSearchParams` / `URL` implementations, so pass decoded strings rather
 * than pre-encoded query fragments. Record-based and schema-based conversions
 * collapse repeated keys into string arrays and do not preserve the full global
 * pair ordering; `schemaJsonField` reads the first matching value for the
 * selected field.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Equal from "../../Equal.ts"
import * as Equ from "../../Equivalence.ts"
import { dual } from "../../Function.ts"
import * as Hash from "../../Hash.ts"
import type { Inspectable } from "../../Inspectable.ts"
import { PipeInspectableProto } from "../../internal/core.ts"
import * as Option from "../../Option.ts"
import type { Pipeable } from "../../Pipeable.ts"
import { hasProperty } from "../../Predicate.ts"
import type { ReadonlyRecord } from "../../Record.ts"
import * as Result from "../../Result.ts"
import * as Schema from "../../Schema.ts"
import * as Issue from "../../SchemaIssue.ts"
import * as Transformation from "../../SchemaTransformation.ts"
import * as Tuple from "../../Tuple.ts"

const TypeId = "~effect/http/UrlParams"

/**
 * Immutable collection of URL query parameters.
 *
 * **Details**
 *
 * Parameters are stored as ordered string key-value pairs and can contain multiple
 * values for the same key.
 *
 * @category models
 * @since 4.0.0
 */
export interface UrlParams extends Pipeable, Inspectable, Iterable<readonly [string, string]> {
  readonly [TypeId]: typeof TypeId
  readonly params: ReadonlyArray<readonly [string, string]>
}

/**
 * Returns `true` when a value is a `UrlParams` instance.
 *
 * @category guards
 * @since 4.0.0
 */
export const isUrlParams = (u: unknown): u is UrlParams => hasProperty(u, TypeId)

/**
 * Input accepted when constructing `UrlParams`.
 *
 * **Details**
 *
 * Values can be provided as a coercible record, an iterable of key-value pairs, or
 * a native `URLSearchParams` value.
 *
 * @category models
 * @since 4.0.0
 */
export type Input =
  | CoercibleRecordInput
  | Iterable<readonly [string, Coercible]>
  | URLSearchParams

type CoercibleRecordInput = CoercibleRecord & {
  readonly [Symbol.iterator]?: never
}

/**
 * Primitive value that can be converted into a URL parameter string.
 *
 * **Gotchas**
 *
 * `undefined` values are skipped when constructing from input.
 *
 * @category models
 * @since 4.0.0
 */
export type Coercible = string | number | bigint | boolean | null | undefined

/**
 * @category models
 * @since 4.0.0
 */
type CoercibleRecordField<A> = A extends Coercible ? A
  : A extends ReadonlyArray<infer Item> ? ReadonlyArray<Item extends Coercible ? Item : never>
  : A extends object ? CoercibleRecord<A>
  : never

/**
 * Record input whose fields can be coerced into URL parameter values.
 *
 * **Details**
 *
 * Nested records are rendered using bracket notation, and arrays produce repeated
 * parameters.
 *
 * @category models
 * @since 4.0.0
 */
export type CoercibleRecord<A extends object = any> = {
  readonly [K in keyof A]: CoercibleRecordField<A[K]>
}

const Proto = {
  ...PipeInspectableProto,
  [TypeId]: TypeId,
  [Symbol.iterator](this: UrlParams) {
    return this.params[Symbol.iterator]()
  },
  toJSON(this: UrlParams): unknown {
    return {
      _id: "UrlParams",
      params: Object.fromEntries(this.params)
    }
  },
  [Equal.symbol](this: UrlParams, that: UrlParams): boolean {
    return Equivalence(this, that)
  },
  [Hash.symbol](this: UrlParams): number {
    return Hash.array(this.params.flat())
  }
}

/**
 * Creates `UrlParams` from ordered string key-value pairs.
 *
 * **Details**
 *
 * The input pairs are used as-is and are not coerced or normalized.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (params: ReadonlyArray<readonly [string, string]>): UrlParams => {
  const self = Object.create(Proto)
  self.params = params
  return self
}

/**
 * Creates `UrlParams` from a supported input shape.
 *
 * **Details**
 *
 * Primitive values are converted to strings, arrays produce repeated parameters,
 * nested records use bracket notation, and `undefined` values are omitted.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromInput = (input: Input): UrlParams => {
  const parsed = fromInputNested(input)
  const out: Array<[string, string]> = []
  for (let i = 0; i < parsed.length; i++) {
    if (Array.isArray(parsed[i][0])) {
      const [keys, value] = parsed[i] as [Array<string>, string]
      out.push([`${keys[0]}[${keys.slice(1).join("][")}]`, value])
    } else {
      out.push(parsed[i] as [string, string])
    }
  }
  return make(out)
}

const fromInputNested = (input: Input): Array<[string | Array<string>, any]> => {
  const entries = typeof (input as any)[Symbol.iterator] === "function"
    ? Arr.fromIterable(input as Iterable<readonly [string, Coercible]>)
    : Object.entries(input)
  const out: Array<[string | Array<string>, string]> = []
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== undefined) {
          out.push([key, String(value[i])])
        }
      }
    } else if (typeof value === "object") {
      const nested = fromInputNested(value as CoercibleRecord)
      for (const [k, v] of nested) {
        out.push([[key, ...(typeof k === "string" ? [k] : k)], v])
      }
    } else if (value !== undefined) {
      out.push([key, String(value)])
    }
  }
  return out
}

/**
 * Provides an order-sensitive `Equivalence` instance for `UrlParams`.
 *
 * **Details**
 *
 * Two values are equivalent when they contain the same key-value pairs in the same
 * order.
 *
 * @category instances
 * @since 4.0.0
 */
export const Equivalence: Equ.Equivalence<UrlParams> = Equ.make<UrlParams>((a, b) =>
  arrayEquivalence(a.params, b.params)
)

const arrayEquivalence = Arr.makeEquivalence(
  Tuple.makeEquivalence([Equ.strictEqual<string>(), Equ.strictEqual<string>()])
)

/**
 * Schema type for `UrlParams`.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface UrlParamsSchema extends Schema.declare<UrlParams, ReadonlyArray<readonly [string, string]>> {}

/**
 * Schema for `UrlParams`.
 *
 * **Details**
 *
 * The encoded representation is an array of string key-value tuples.
 *
 * @category schemas
 * @since 4.0.0
 */
export const UrlParamsSchema: UrlParamsSchema = Schema.declare(
  isUrlParams,
  {
    typeConstructor: {
      _tag: "effect/http/UrlParams"
    },
    generation: {
      runtime: `UrlParams.UrlParamsSchema`,
      Type: `UrlParams.UrlParams`,
      Encoded: `typeof UrlParams.UrlParamsSchema["Encoded"]`,
      importDeclaration: `import * as UrlParams from "effect/unstable/http/UrlParams"`
    },
    expected: "UrlParams",
    toEquivalence: () => Equivalence,
    toCodec: () =>
      Schema.link<UrlParams>()(
        Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
        Transformation.transform({
          decode: make,
          encode: (self) => self.params
        })
      )
  }
)

/**
 * An empty `UrlParams` value.
 *
 * @category constructors
 * @since 4.0.0
 */
export const empty: UrlParams = make([])

/**
 * Returns all values for a query parameter key in insertion order.
 *
 * **Details**
 *
 * Returns an empty array when the key is absent.
 *
 * @category combinators
 * @since 4.0.0
 */
export const getAll: {
  (key: string): (self: UrlParams) => ReadonlyArray<string>
  (self: UrlParams, key: string): ReadonlyArray<string>
} = dual(
  2,
  (self: UrlParams, key: string): ReadonlyArray<string> =>
    Arr.reduce(self.params, [] as Array<string>, (acc, [k, value]) => {
      if (k === key) {
        acc.push(value)
      }
      return acc
    })
)

/**
 * Returns the first value for a query parameter key safely.
 *
 * **Details**
 *
 * Returns `Option.none` when the key is absent.
 *
 * @category combinators
 * @since 4.0.0
 */
export const getFirst: {
  (key: string): (self: UrlParams) => Option.Option<string>
  (self: UrlParams, key: string): Option.Option<string>
} = dual(
  2,
  (self: UrlParams, key: string): Option.Option<string> =>
    Arr.findFirst(self.params, ([k]) => k === key).pipe(
      Option.map(([, value]) => value)
    )
)

/**
 * Returns the last value for a query parameter key safely.
 *
 * **Details**
 *
 * Returns `Option.none` when the key is absent.
 *
 * @category combinators
 * @since 4.0.0
 */
export const getLast: {
  (key: string): (self: UrlParams) => Option.Option<string>
  (self: UrlParams, key: string): Option.Option<string>
} = dual(2, (self: UrlParams, key: string): Option.Option<string> =>
  Arr.findLast(self.params, ([k]) => k === key).pipe(
    Option.map(([, value]) => value)
  ))

/**
 * Sets a query parameter to a single value.
 *
 * **Details**
 *
 * Existing values for the same key are removed, and the new value is appended to
 * the end.
 *
 * @category combinators
 * @since 4.0.0
 */
export const set: {
  (key: string, value: Coercible): (self: UrlParams) => UrlParams
  (self: UrlParams, key: string, value: Coercible): UrlParams
} = dual(3, (self: UrlParams, key: string, value: Coercible): UrlParams =>
  make(
    Arr.append(
      Arr.filter(self.params, ([k]) => k !== key),
      [key, String(value)]
    )
  ))

/**
 * Transforms the underlying ordered key-value pairs of `UrlParams`.
 *
 * **Details**
 *
 * The result is wrapped in a new `UrlParams` value.
 *
 * @category combinators
 * @since 4.0.0
 */
export const transform: {
  (f: (params: UrlParams["params"]) => UrlParams["params"]): (self: UrlParams) => UrlParams
  (self: UrlParams, f: (params: UrlParams["params"]) => UrlParams["params"]): UrlParams
} = dual(
  2,
  (self: UrlParams, f: (params: UrlParams["params"]) => UrlParams["params"]): UrlParams => make(f(self.params))
)

/**
 * Sets multiple query parameters from input.
 *
 * **Details**
 *
 * Keys present in the input replace existing values for those keys, while
 * unmentioned existing parameters are preserved.
 *
 * @category combinators
 * @since 4.0.0
 */
export const setAll: {
  (input: Input): (self: UrlParams) => UrlParams
  (self: UrlParams, input: Input): UrlParams
} = dual(2, (self: UrlParams, input: Input): UrlParams => {
  const out = fromInput(input)
  const params = out.params as Array<readonly [string, string]>
  const keys = new Set()
  for (let i = 0; i < params.length; i++) {
    keys.add(params[i][0])
  }
  for (let i = 0; i < self.params.length; i++) {
    if (keys.has(self.params[i][0])) continue
    params.push(self.params[i])
  }
  return out
})

/**
 * Appends a query parameter value without removing existing values for the key.
 *
 * @category combinators
 * @since 4.0.0
 */
export const append: {
  (key: string, value: Coercible): (self: UrlParams) => UrlParams
  (self: UrlParams, key: string, value: Coercible): UrlParams
} = dual(3, (self: UrlParams, key: string, value: Coercible): UrlParams =>
  make(Arr.append(
    self.params,
    [key, String(value)]
  )))

/**
 * Appends all query parameters produced from the supplied input.
 *
 * **Details**
 *
 * Existing parameters are preserved.
 *
 * @category combinators
 * @since 4.0.0
 */
export const appendAll: {
  (input: Input): (self: UrlParams) => UrlParams
  (self: UrlParams, input: Input): UrlParams
} = dual(2, (self: UrlParams, input: Input): UrlParams => transform(self, Arr.appendAll(fromInput(input).params)))

/**
 * Removes all query parameter values for the specified key.
 *
 * @category combinators
 * @since 4.0.0
 */
export const remove: {
  (key: string): (self: UrlParams) => UrlParams
  (self: UrlParams, key: string): UrlParams
} = dual(2, (self: UrlParams, key: string): UrlParams => transform(self, Arr.filter(([k]) => k !== key)))

/**
 * Error returned when constructing a `URL` from `UrlParams` fails.
 *
 * @category errors
 * @since 4.0.0
 */
export class UrlParamsError extends Data.TaggedError("UrlParamsError")<{
  cause: unknown
}> {}

/**
 * Creates a `URL` safely by appending `UrlParams` and an optional hash to a URL string.
 *
 * **Details**
 *
 * Returns a `Result` that fails with `UrlParamsError` if the URL cannot be
 * constructed.
 *
 * @category converting
 * @since 4.0.0
 */
export const makeUrl = (
  url: string,
  params: UrlParams,
  hash: string | undefined
): Result.Result<URL, UrlParamsError> => {
  try {
    const urlInstance = new URL(url, baseUrl())
    for (let i = 0; i < params.params.length; i++) {
      const [key, value] = params.params[i]
      if (value !== undefined) {
        urlInstance.searchParams.append(key, value)
      }
    }
    if (hash !== undefined) {
      urlInstance.hash = hash
    }
    return Result.succeed(urlInstance)
  } catch (e) {
    return Result.fail(new UrlParamsError({ cause: e }))
  }
}

/**
 * Serializes `UrlParams` to a URL query string without a leading question mark.
 *
 * @category converting
 * @since 4.0.0
 */
export const toString = (self: UrlParams): string => new URLSearchParams(self.params as any).toString()

const baseUrl = (): string | undefined => {
  if (
    "location" in globalThis &&
    globalThis.location !== undefined &&
    globalThis.location.origin !== undefined &&
    globalThis.location.pathname !== undefined
  ) {
    return location.origin + location.pathname
  }
  return undefined
}

/**
 * Builds a `Record` containing all the key-value pairs in the given `UrlParams`
 * as `string` (if only one value for a key) or a `NonEmptyArray<string>`
 * (when more than one value for a key)
 *
 * **Example** (Converting parameters to a record)
 *
 * ```ts
 * import { UrlParams } from "effect/unstable/http"
 * import * as assert from "node:assert"
 *
 * const urlParams = UrlParams.fromInput({
 *   a: 1,
 *   b: true,
 *   c: "string",
 *   e: [1, 2, 3]
 * })
 * const result = UrlParams.toRecord(urlParams)
 *
 * assert.deepStrictEqual(
 *   result,
 *   { "a": "1", "b": "true", "c": "string", "e": ["1", "2", "3"] }
 * )
 * ```
 *
 * @category converting
 * @since 4.0.0
 */
export const toRecord = (self: UrlParams): Record<string, string | Arr.NonEmptyArray<string>> => {
  const out: Record<string, string | Arr.NonEmptyArray<string>> = {}
  for (const [k, value] of self.params) {
    const curr = out[k]
    if (curr === undefined) {
      out[k] = value
    } else if (typeof curr === "string") {
      out[k] = [curr, value]
    } else {
      curr.push(value)
    }
  }
  return out
}

/**
 * Builds a readonly record from `UrlParams`.
 *
 * **Details**
 *
 * Keys with one value map to a string, and keys with multiple values map to a
 * non-empty readonly array of strings.
 *
 * @category converting
 * @since 4.0.0
 */
export const toReadonlyRecord: (self: UrlParams) => ReadonlyRecord<string, string | Arr.NonEmptyReadonlyArray<string>> =
  toRecord as any

/**
 * Schema type for decoding one URL parameter field as JSON.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface schemaJsonField extends Schema.decodeTo<Schema.UnknownFromJsonString, UrlParamsSchema> {}

/**
 * Extracts a JSON value from the first occurrence of the given `field` in the
 * `UrlParams`.
 *
 * **Example** (Decoding JSON parameter fields)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { UrlParams } from "effect/unstable/http"
 *
 * const extractFoo = UrlParams.schemaJsonField("foo").pipe(
 *   Schema.decodeTo(Schema.Struct({
 *     some: Schema.String,
 *     number: Schema.Number
 *   }))
 * )
 *
 * console.log(
 *   Schema.decodeSync(extractFoo)(UrlParams.fromInput({
 *     foo: JSON.stringify({ some: "bar", number: 42 }),
 *     baz: "qux"
 *   }))
 * )
 * ```
 *
 * @category schemas
 * @since 4.0.0
 */
export const schemaJsonField = (field: string): schemaJsonField =>
  UrlParamsSchema.pipe(
    Schema.decodeTo(
      Schema.UnknownFromJsonString,
      Transformation.transformOrFail({
        decode: (params) =>
          Option.match(getFirst(params, field), {
            onNone: () => Effect.fail(new Issue.Pointer([field], new Issue.MissingKey(undefined))),
            onSome: Effect.succeed
          }),
        encode: (value) => Effect.succeed(make([[field, value]]))
      })
    )
  )

/**
 * Extract a record of key-value pairs from the `UrlParams`.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface schemaRecord extends
  Schema.decodeTo<
    Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.NonEmptyArray<Schema.String>]>>,
    UrlParamsSchema,
    never,
    never
  >
{}

/**
 * Schema that decodes `UrlParams` into a record of key-value pairs.
 *
 * **Details**
 *
 * Keys with one value decode to a string, and keys with multiple values decode to
 * a non-empty readonly array of strings.
 *
 * **Example** (Decoding URL parameters to a record)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { UrlParams } from "effect/unstable/http"
 *
 * const toStruct = UrlParams.schemaRecord.pipe(
 *   Schema.decodeTo(Schema.Struct({
 *     some: Schema.String,
 *     number: Schema.FiniteFromString
 *   }))
 * )
 *
 * console.log(
 *   Schema.decodeSync(toStruct)(UrlParams.fromInput({
 *     some: "value",
 *     number: 42
 *   }))
 * )
 * ```
 *
 * @category schemas
 * @since 4.0.0
 */
export const schemaRecord: schemaRecord = UrlParamsSchema.pipe(
  Schema.decodeTo(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.NonEmptyArray(Schema.String)])
    ),
    Transformation.transform({
      decode: toReadonlyRecord,
      encode: fromInput
    })
  )
)
