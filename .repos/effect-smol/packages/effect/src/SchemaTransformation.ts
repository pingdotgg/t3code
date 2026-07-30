/**
 * Builds two-way conversions used by schemas.
 *
 * A `Transformation<T, E>` describes how to decode an encoded value into a
 * decoded value and how to encode it back again. Schema APIs use
 * transformations to connect two representations, such as a string and a
 * number, a JSON value and a richer TypeScript value, or a form field and an
 * application value. This module includes transformation and middleware types,
 * constructors for pure or effectful conversions, and common conversions used
 * by the Schema module.
 *
 * @since 4.0.0
 */

import * as BigDecimal from "./BigDecimal.ts"
import * as DateTime from "./DateTime.ts"
import * as Duration from "./Duration.ts"
import * as Effect from "./Effect.ts"
import { format, formatDate, formatJson } from "./Formatter.ts"
import * as Option from "./Option.ts"
import * as Predicate from "./Predicate.ts"
import type { ErrorOptions, Json } from "./Schema.ts"
import type * as SchemaAST from "./SchemaAST.ts"
import * as SchemaGetter from "./SchemaGetter.ts"
import * as SchemaIssue from "./SchemaIssue.ts"

/**
 * Middleware that wraps the entire parsing `Effect` pipeline for both
 * decode and encode directions.
 *
 * **When to use**
 *
 * Use when you need a schema middleware to catch or recover from parsing
 * errors (e.g. `Schema.catchDecoding`), run side effects around the parsing
 * pipeline, or access the full `Effect` rather than a single decoded value.
 *
 * **Details**
 *
 * Unlike `Transformation`, which operates on individual values via `Getter`,
 * `Middleware` receives the full `Effect` produced by the inner schema and can
 * intercept, modify, retry, or replace it.
 *
 * - `decode` receives an `Effect<Option<E>, Issue, RDE>` and returns
 *   `Effect<Option<T>, Issue, RDT>`.
 * - `encode` receives an `Effect<Option<T>, Issue, RET>` and returns
 *   `Effect<Option<E>, Issue, REE>`.
 * - `flip()` swaps the decode and encode functions, producing a
 *   `Middleware<E, T, ...>`.
 *
 * Typically constructed indirectly via `Schema.middlewareDecoding` or
 * `Schema.middlewareEncoding` rather than instantiating this class directly.
 *
 * **Example** (Creating a middleware that falls back on decode failure)
 *
 * ```ts
 * import { Effect, Option, SchemaTransformation } from "effect"
 *
 * const fallback = new SchemaTransformation.Middleware(
 *   (effect) => Effect.catch(effect, () => Effect.succeed(Option.some("fallback"))),
 *   (effect) => effect
 * )
 * ```
 *
 * @see {@link Transformation} — value-level bidirectional transformation
 *
 * @category models
 * @since 4.0.0
 */
export class Middleware<in out T, in out E, RDE, RDT, RET, REE> {
  readonly _tag = "Middleware"
  readonly decode: (
    effect: Effect.Effect<Option.Option<E>, SchemaIssue.Issue, RDE>,
    options: SchemaAST.ParseOptions
  ) => Effect.Effect<Option.Option<T>, SchemaIssue.Issue, RDT>
  readonly encode: (
    effect: Effect.Effect<Option.Option<T>, SchemaIssue.Issue, RET>,
    options: SchemaAST.ParseOptions
  ) => Effect.Effect<Option.Option<E>, SchemaIssue.Issue, REE>

  constructor(
    decode: (
      effect: Effect.Effect<Option.Option<E>, SchemaIssue.Issue, RDE>,
      options: SchemaAST.ParseOptions
    ) => Effect.Effect<Option.Option<T>, SchemaIssue.Issue, RDT>,
    encode: (
      effect: Effect.Effect<Option.Option<T>, SchemaIssue.Issue, RET>,
      options: SchemaAST.ParseOptions
    ) => Effect.Effect<Option.Option<E>, SchemaIssue.Issue, REE>
  ) {
    this.decode = decode
    this.encode = encode
  }
  flip(): Middleware<E, T, RET, REE, RDE, RDT> {
    return new Middleware(this.encode, this.decode)
  }
}

const TypeId = "~effect/SchemaTransformation/Transformation"

/**
 * Represents a bidirectional transformation between a decoded type `T` and an encoded
 * type `E`, built from a pair of `Getter`s.
 *
 * **When to use**
 *
 * Use when you need a schema transformation that defines how a schema converts
 * between two representations.
 * - You want to compose multiple transformations into a pipeline.
 * - You want to flip a transformation to swap decode/encode.
 *
 * **Details**
 *
 * This is the primary building block for `Schema.decodeTo`, `Schema.encodeTo`,
 * `Schema.decode`, `Schema.encode`, and `Schema.link`. Each direction is a
 * `SchemaGetter.Getter` that handles optionality, failure, and Effect services.
 *
 * - Immutable — `flip()` and `compose()` return new instances.
 * - `flip()` swaps the decode and encode getters.
 * - `compose(other)` chains: `this.decode` then `other.decode` for decoding,
 *   `other.encode` then `this.encode` for encoding.
 *
 * **Example** (Composing two transformations)
 *
 * ```ts
 * import { SchemaTransformation } from "effect"
 *
 * const trimAndLower = SchemaTransformation.trim().compose(
 *   SchemaTransformation.toLowerCase()
 * )
 * // decode: trim then lowercase
 * // encode: passthrough (both directions)
 * ```
 *
 * @see {@link make} — construct from `{ decode, encode }` getters
 * @see {@link transform} — construct from pure functions
 * @see {@link transformOrFail} — construct from effectful functions
 * @see {@link Middleware} — effect-pipeline-level alternative
 *
 * @category models
 * @since 4.0.0
 */
export class Transformation<in out T, in out E, RD = never, RE = never> {
  readonly [TypeId] = TypeId
  readonly _tag = "Transformation"
  readonly decode: SchemaGetter.Getter<T, E, RD>
  readonly encode: SchemaGetter.Getter<E, T, RE>

  constructor(
    decode: SchemaGetter.Getter<T, E, RD>,
    encode: SchemaGetter.Getter<E, T, RE>
  ) {
    this.decode = decode
    this.encode = encode
  }
  flip(): Transformation<E, T, RE, RD> {
    return new Transformation(this.encode, this.decode)
  }
  compose<T2, RD2, RE2>(other: Transformation<T2, T, RD2, RE2>): Transformation<T2, E, RD | RD2, RE | RE2> {
    return new Transformation(
      this.decode.compose(other.decode),
      other.encode.compose(this.encode)
    )
  }
}

/**
 * Returns `true` if `u` is a `Transformation` instance.
 *
 * **When to use**
 *
 * Use to check whether a value is already a schema transformation before
 * wrapping it.
 *
 * **Details**
 *
 * - Pure predicate, no side effects.
 * - Acts as a TypeScript type guard.
 *
 * **Example** (Checking a value)
 *
 * ```ts
 * import { SchemaTransformation } from "effect"
 *
 * SchemaTransformation.isTransformation(SchemaTransformation.trim())
 * // true
 *
 * SchemaTransformation.isTransformation({ decode: null, encode: null })
 * // false
 * ```
 *
 * @see {@link Transformation}
 * @see {@link make}
 *
 * @category guards
 * @since 4.0.0
 */
export function isTransformation(u: unknown): u is Transformation<any, any, unknown, unknown> {
  return Predicate.hasProperty(u, TypeId) && u[TypeId] === TypeId
}

/**
 * Constructs a `Transformation` from an object with `decode` and `encode`
 * `Getter`s. If the input is already a `Transformation`, returns it as-is.
 *
 * **When to use**
 *
 * Use when you already have schema getter instances and want to pair them into
 * a schema transformation.
 * - You want idempotent wrapping (won't double-wrap).
 *
 * **Details**
 *
 * - Returns the input unchanged if it is already a `Transformation`.
 *
 * **Example** (Wrapping existing getters)
 *
 * ```ts
 * import { SchemaGetter, SchemaTransformation } from "effect"
 *
 * const t = SchemaTransformation.make({
 *   decode: SchemaGetter.transform<number, string>((s) => Number(s)),
 *   encode: SchemaGetter.transform<string, number>((n) => String(n))
 * })
 * ```
 *
 * @see {@link transform} — simpler constructor from pure functions
 * @see {@link transformOrFail} — constructor from effectful functions
 * @see {@link Transformation}
 *
 * @category constructors
 * @since 3.10.0
 */
export const make = <T, E, RD = never, RE = never>(options: {
  readonly decode: SchemaGetter.Getter<T, E, RD>
  readonly encode: SchemaGetter.Getter<E, T, RE>
}): Transformation<T, E, RD, RE> => {
  if (isTransformation(options)) {
    return options as any
  }
  return new Transformation(options.decode, options.encode)
}

/**
 * Creates a `Transformation` from effectful decode and encode functions that
 * can fail with `Issue`.
 *
 * **When to use**
 *
 * Use when you need a schema transformation that may fail or require Effect
 * services.
 *
 * **Details**
 *
 * - Each function receives the input value and `ParseOptions`.
 * - Must return an `Effect` that succeeds with the output or fails with `Issue`.
 * - Skips `None` inputs (missing keys) — functions are only called on present values.
 *
 * **Example** (Parsing a date string that can fail)
 *
 * ```ts
 * import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect"
 *
 * const DateFromString = Schema.String.pipe(
 *   Schema.decodeTo(
 *     Schema.Date,
 *     SchemaTransformation.transformOrFail({
 *       decode: (s) => {
 *         const d = new Date(s)
 *         return isNaN(d.getTime())
 *           ? Effect.fail(new SchemaIssue.InvalidValue(Option.some(s), { message: "Invalid date" }))
 *           : Effect.succeed(d)
 *       },
 *       encode: (d) => Effect.succeed(d.toISOString())
 *     })
 *   )
 * )
 * ```
 *
 * @see {@link transform} — for infallible, pure transformations
 * @see {@link transformOptional} — for transformations that handle missing keys
 * @see {@link make} — for transformations from existing Getters
 *
 * @category constructors
 * @since 3.10.0
 */
export function transformOrFail<T, E, RD = never, RE = never>(options: {
  readonly decode: (e: E, options: SchemaAST.ParseOptions) => Effect.Effect<T, SchemaIssue.Issue, RD>
  readonly encode: (t: T, options: SchemaAST.ParseOptions) => Effect.Effect<E, SchemaIssue.Issue, RE>
}): Transformation<T, E, RD, RE> {
  return new Transformation(
    SchemaGetter.transformOrFail(options.decode),
    SchemaGetter.transformOrFail(options.encode)
  )
}

/**
 * Creates a `Transformation` from pure (sync, infallible) decode and encode
 * functions.
 *
 * **When to use**
 *
 * Use when you need an infallible schema transformation that does not require
 * Effect services.
 *
 * **Details**
 *
 * - Each function receives the input and returns the output directly.
 * - Skips `None` inputs (missing keys) — functions are only called on present values.
 * - Does not allocate Effects internally; uses optimized sync path.
 *
 * **Example** (Converting between cents and dollars)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const CentsFromDollars = Schema.Number.pipe(
 *   Schema.decodeTo(
 *     Schema.Number,
 *     SchemaTransformation.transform({
 *       decode: (dollars) => dollars * 100,
 *       encode: (cents) => cents / 100
 *     })
 *   )
 * )
 * ```
 *
 * @see {@link transformOrFail} — for fallible or effectful transformations
 * @see {@link transformOptional} — for transformations that handle missing keys
 * @see {@link passthrough} — when no conversion is needed
 *
 * @category constructors
 * @since 3.10.0
 */
export function transform<T, E>(options: {
  readonly decode: (input: E) => T
  readonly encode: (input: T) => E
}): Transformation<T, E> {
  return new Transformation(
    SchemaGetter.transform(options.decode),
    SchemaGetter.transform(options.encode)
  )
}

/**
 * Creates a `Transformation` where decode and encode operate on `Option`
 * values, giving full control over missing-key handling.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to produce or consume `Option.None`
 * for absent keys.
 * - You are working with optional struct fields.
 *
 * **Details**
 *
 * - Each function receives `Option<input>` and returns `Option<output>`.
 * - `Option.None` input means the key is absent; returning `Option.None`
 *   omits the key from the output.
 * - Pure and synchronous.
 *
 * **Example** (Converting an optional key to Option)
 *
 * ```ts
 * import { Option, Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.Struct({
 *   a: Schema.optionalKey(Schema.Number).pipe(
 *     Schema.decodeTo(
 *       Schema.Option(Schema.Number),
 *       SchemaTransformation.transformOptional({
 *         decode: Option.some,
 *         encode: Option.flatten
 *       })
 *     )
 *   )
 * })
 * ```
 *
 * @see {@link transform} — when you don't need Option-level control
 * @see {@link optionFromOptionalKey} — built-in for the common optional-key-to-Option pattern
 * @see {@link optionFromOptional} — built-in for optional (undefined) to Option
 *
 * @category constructors
 * @since 4.0.0
 */
export function transformOptional<T, E>(options: {
  readonly decode: (input: Option.Option<E>) => Option.Option<T>
  readonly encode: (input: Option.Option<T>) => Option.Option<E>
}): Transformation<T, E> {
  return new Transformation(
    SchemaGetter.transformOptional(options.decode),
    SchemaGetter.transformOptional(options.encode)
  )
}

/**
 * Transforms strings by trimming whitespace on decode.
 * Encode is passthrough (no change).
 *
 * **When to use**
 *
 * Use when you need a schema transformation to normalize user input by
 * stripping leading/trailing whitespace.
 *
 * **Details**
 *
 * Decoding applies `String.prototype.trim()`. Encoding is passthrough and
 * returns the string unchanged. This is not round-trippable if the original had
 * whitespace.
 *
 * **Example** (Trimming on decode)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Trimmed = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.trim())
 * )
 * ```
 *
 * @see {@link toLowerCase}
 * @see {@link toUpperCase}
 * @see {@link snakeToCamel}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function trim(): Transformation<string, string> {
  return new Transformation(
    SchemaGetter.trim(),
    SchemaGetter.passthrough()
  )
}

/**
 * Transforms strings by converting snake_case to camelCase
 * on decode and camelCase to snake_case on encode.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to convert API field names between
 * snake_case and camelCase conventions.
 *
 * **Details**
 *
 * Decoding converts values such as `"my_field_name"` to `"myFieldName"`.
 * Encoding converts values such as `"myFieldName"` back to `"my_field_name"`.
 * The transformation is round-trippable for standard snake_case and camelCase.
 *
 * **Example** (Converting snake case to camel case)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const SnakeToCamel = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.snakeToCamel())
 * )
 * ```
 *
 * @see {@link trim}
 * @see {@link toLowerCase}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function snakeToCamel(): Transformation<string, string> {
  return new Transformation(
    SchemaGetter.snakeToCamel(),
    SchemaGetter.camelToSnake()
  )
}

/**
 * Transforms strings by lowercasing on decode.
 * Encode is passthrough.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to normalize strings to lowercase
 * (e.g. email addresses).
 *
 * **Details**
 *
 * Decoding applies `String.prototype.toLowerCase()`. Encoding is passthrough.
 * This is not round-trippable if the original had uppercase characters.
 *
 * **Example** (Lowercasing on decode)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Lowered = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.toLowerCase())
 * )
 * ```
 *
 * @see {@link toUpperCase}
 * @see {@link trim}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function toLowerCase(): Transformation<string, string> {
  return new Transformation(
    SchemaGetter.toLowerCase(),
    SchemaGetter.passthrough()
  )
}

/**
 * Transforms strings by uppercasing on decode.
 * Encode is passthrough.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to normalize strings to uppercase
 * (e.g. country codes).
 *
 * **Details**
 *
 * Decoding applies `String.prototype.toUpperCase()`. Encoding is passthrough.
 * This is not round-trippable if the original had lowercase characters.
 *
 * **Example** (Uppercasing on decode)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Uppered = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.toUpperCase())
 * )
 * ```
 *
 * @see {@link toLowerCase}
 * @see {@link trim}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function toUpperCase(): Transformation<string, string> {
  return new Transformation(
    SchemaGetter.toUpperCase(),
    SchemaGetter.passthrough()
  )
}

/**
 * Transforms strings by capitalizing the first character on
 * decode. Encode is passthrough.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to normalize display names or
 * titles.
 *
 * **Details**
 *
 * Decoding uppercases the first character and leaves the rest unchanged.
 * Encoding is passthrough.
 *
 * **Example** (Capitalizing on decode)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Capitalized = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.capitalize())
 * )
 * ```
 *
 * @see {@link uncapitalize}
 * @see {@link toUpperCase}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function capitalize(): Transformation<string, string> {
  return new Transformation(
    SchemaGetter.capitalize(),
    SchemaGetter.passthrough()
  )
}

/**
 * Transforms strings by lowercasing the first character on
 * decode. Encode is passthrough.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to normalize identifiers or field
 * names.
 *
 * **Details**
 *
 * Decoding lowercases the first character and leaves the rest unchanged.
 * Encoding is passthrough.
 *
 * **Example** (Uncapitalizing on decode)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Uncapitalized = Schema.String.pipe(
 *   Schema.decode(SchemaTransformation.uncapitalize())
 * )
 * ```
 *
 * @see {@link capitalize}
 * @see {@link toLowerCase}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function uncapitalize(): Transformation<string, string> {
  return new Transformation(
    SchemaGetter.uncapitalize(),
    SchemaGetter.passthrough()
  )
}

/**
 * Transforms a string into a record of key-value pairs and
 * encodes a record of key-value pairs into a string.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to parse query-string-like or
 * config-file-like strings into records.
 *
 * **Details**
 *
 * Decoding splits the string by `separator` (default `","`) into pairs, then
 * splits each pair by `keyValueSeparator` (default `"="`). Encoding joins the
 * record back into a string using the same separators. The transformation is
 * round-trippable when keys and values do not contain the separators.
 *
 * **Example** (Parsing key-value pairs)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const Config = Schema.String.pipe(
 *   Schema.decodeTo(
 *     Schema.Record(Schema.String, Schema.String),
 *     SchemaTransformation.splitKeyValue({ separator: ";", keyValueSeparator: ":" })
 *   )
 * )
 * // "host:localhost;port:3000" → { host: "localhost", port: "3000" }
 * ```
 *
 * @see {@link trim}
 * @see {@link snakeToCamel}
 *
 * @category String transformations
 * @since 4.0.0
 */
export function splitKeyValue(options?: {
  readonly separator?: string | undefined
  readonly keyValueSeparator?: string | undefined
}): Transformation<Record<string, string>, string> {
  return new Transformation(
    SchemaGetter.splitKeyValue(options),
    SchemaGetter.joinKeyValue(options)
  )
}

const passthrough_ = new Transformation(
  SchemaGetter.passthrough<any>(),
  SchemaGetter.passthrough<any>()
)

/**
 * Transforms values by returning the input unchanged in both
 * directions.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to connect two schemas that share
 * the same type with no actual conversion.
 *
 * **Details**
 *
 * - Both decode and encode are no-ops.
 * - Returns a shared singleton instance (no allocation per call).
 * - By default, `T` and `E` must be the same type. Pass `{ strict: false }`
 *   to bypass the type constraint.
 *
 * **Example** (Chaining schemas with no conversion)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.Trim.pipe(
 *   Schema.decodeTo(Schema.FiniteFromString, SchemaTransformation.passthrough())
 * )
 * ```
 *
 * @see {@link passthroughSupertype}
 * @see {@link passthroughSubtype}
 * @see {@link transform}
 *
 * @category constructors
 * @since 4.0.0
 */
export function passthrough<T, E>(options: { readonly strict: false }): Transformation<T, E>
export function passthrough<T>(): Transformation<T, T>
export function passthrough<T>(): Transformation<T, T> {
  return passthrough_
}

/**
 * Transforms values without changing them, typed so that `T extends E`, where the decoded
 * type `T` is a subtype of the encoded type `E`.
 *
 * **When to use**
 *
 * Use when you need a no-op schema transformation whose decoded side is
 * narrower than the encoded side.
 *
 * **Details**
 *
 * Both decode and encode are no-ops and return a shared singleton
 * transformation.
 *
 * **Example** (Passing through supertypes)
 *
 * ```ts
 * import { SchemaTransformation } from "effect"
 *
 * const t = SchemaTransformation.passthroughSupertype<"a" | "b", string>()
 * ```
 *
 * @see {@link passthrough}
 * @see {@link passthroughSubtype}
 *
 * @category constructors
 * @since 4.0.0
 */
export function passthroughSupertype<T extends E, E>(): Transformation<T, E>
export function passthroughSupertype<T>(): Transformation<T, T> {
  return passthrough_
}

/**
 * Transforms values without changing them, typed so that `E extends T` — the encoded
 * type is a subtype of the decoded type.
 *
 * **When to use**
 *
 * Use when you need a no-op schema transformation whose encoded side is more
 * specific than its decoded side.
 *
 * **Details**
 *
 * - Both decode and encode are no-ops (same as {@link passthrough}).
 * - Returns a shared singleton instance.
 *
 * **Example** (Passing through subtypes)
 *
 * ```ts
 * import { SchemaTransformation } from "effect"
 *
 * const t = SchemaTransformation.passthroughSubtype<string, "a" | "b">()
 * ```
 *
 * @see {@link passthrough}
 * @see {@link passthroughSupertype}
 *
 * @category constructors
 * @since 4.0.0
 */
export function passthroughSubtype<T, E extends T>(): Transformation<T, E>
export function passthroughSubtype<T>(): Transformation<T, T> {
  return passthrough_
}

/**
 * Decodes a `string` into a `number` and encodes a `number` back to a
 * `string`.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to parse numeric strings from APIs,
 * form data, or URL parameters.
 *
 * **Details**
 *
 * Decoding coerces the string to a number like `Number(s)`. Encoding coerces
 * the number to a string like `String(n)`. This does not validate that the
 * result is finite; combine with `Schema.Finite` or `Schema.Int` for stricter
 * checks.
 *
 * **Example** (Converting a string to a number)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Number, SchemaTransformation.numberFromString)
 * )
 * ```
 *
 * @see {@link bigintFromString}
 * @see {@link transform}
 *
 * @category Coercions
 * @since 4.0.0
 */
export const numberFromString = new Transformation(
  SchemaGetter.Number(),
  SchemaGetter.String()
)

/**
 * Decodes a `string` into a `bigint` and encodes a `bigint` back to a
 * `string`.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to parse large integer strings
 * (e.g. database IDs, blockchain values).
 *
 * **Details**
 *
 * Decoding coerces the string to a bigint like `BigInt(s)`. Encoding coerces
 * the bigint to a string like `String(n)`. Decoding fails if the string is not
 * a valid bigint representation.
 *
 * **Example** (Converting a string to a BigInt)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.BigInt, SchemaTransformation.bigintFromString)
 * )
 * ```
 *
 * @see {@link numberFromString}
 * @see {@link transform}
 *
 * @category Coercions
 * @since 4.0.0
 */
export const bigintFromString = new Transformation(
  SchemaGetter.BigInt(),
  SchemaGetter.String()
)

/**
 * Decodes a `string` into a `Date` and encodes a `Date` back to a `string`.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to parse date strings from APIs or
 * user input.
 *
 * **Details**
 *
 * Decoding creates a `Date` from the string like `new Date(s)`. Encoding
 * converts the `Date` to an ISO string like `date.toISOString()`, returning
 * `"Invalid Date"` for invalid dates.
 *
 * **Example** (Converting a string to a Date)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
 * )
 * ```
 *
 * @see {@link dateFromMillis}
 * @see {@link dateTimeUtcFromString}
 *
 * @category Coercions
 * @since 4.0.0
 */
export const dateFromString: Transformation<globalThis.Date, string> = new Transformation(
  SchemaGetter.Date(),
  SchemaGetter.transform(formatDate)
)

/**
 * Decodes epoch milliseconds into a `Date` and encodes a `Date` back to epoch
 * milliseconds.
 *
 * **When to use**
 *
 * Use when you need a schema transformation for numeric timestamps represented
 * as milliseconds since the Unix epoch.
 *
 * **Details**
 *
 * Decoding creates a `Date` from the number like `new Date(ms)`. Encoding
 * returns the `Date` timestamp like `date.getTime()`.
 *
 * **Gotchas**
 *
 * This transformation does not validate date validity. `NaN`, `Infinity`, and
 * `-Infinity` decode to invalid `Date` instances.
 *
 * **Example** (Converting milliseconds to a Date)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.Number.pipe(
 *   Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromMillis)
 * )
 * ```
 *
 * @see {@link dateFromString}
 * @see {@link SchemaGetter.dateTimeUtcFromInput}
 *
 * @category Coercions
 * @since 4.0.0
 */
export const dateFromMillis: Transformation<globalThis.Date, number> = new Transformation(
  SchemaGetter.Date(),
  SchemaGetter.transform((date) => date.getTime())
)

/**
 * Decodes a `string` into a `Duration` and encodes a `Duration` back to a
 * parseable `string`.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to parse human-readable duration
 * strings from APIs, config, or user input.
 *
 * **Details**
 *
 * Decoding accepts any string that `Duration.fromInput` can parse, including
 * `"Infinity"` and `"-Infinity"`. Encoding returns `String(duration)`,
 * producing strings such as `"2000 millis"` or `"10 nanos"` that round-trip
 * through the parser.
 *
 * **Example** (Converting a string to a Duration)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Duration, SchemaTransformation.durationFromString)
 * )
 * ```
 *
 * @see {@link durationFromNanos}
 * @see {@link durationFromMillis}
 *
 * @category transforming
 * @since 4.0.0
 */
export const durationFromString: Transformation<Duration.Duration, string> = transformOrFail<
  Duration.Duration,
  string
>({
  decode: (s) =>
    Option.match(Duration.fromInput(s as Duration.Input), {
      onNone: () =>
        Effect.fail(new SchemaIssue.InvalidValue(Option.some(s), { message: `Invalid Duration string: ${s}` })),
      onSome: Effect.succeed
    }),
  encode: (duration) => Effect.succeed(globalThis.String(duration))
})

/**
 * Decodes a `bigint` (nanoseconds) into a `Duration` and encodes a
 * `Duration` back to `bigint` nanoseconds.
 *
 * **When to use**
 *
 * Use when you need a schema transformation for nanosecond-precision timestamps
 * or intervals.
 *
 * **Details**
 *
 * Decoding always succeeds and creates a `Duration` from nanoseconds. Encoding
 * fails with `InvalidValue` if the `Duration` cannot be represented as a
 * `bigint`, such as `Duration.infinity`.
 *
 * **Example** (Converting nanoseconds to a Duration)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.BigInt.pipe(
 *   Schema.decodeTo(Schema.Duration, SchemaTransformation.durationFromNanos)
 * )
 * ```
 *
 * @see {@link durationFromMillis}
 *
 * @category transforming
 * @since 4.0.0
 */
export const durationFromNanos: Transformation<Duration.Duration, bigint> = transformOrFail({
  decode: (i) => Effect.succeed(Duration.nanos(i)),
  encode: (a) =>
    Option.match(Duration.toNanos(a), {
      onNone: () =>
        Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(a), { message: `Unable to encode ${a} into a bigint` })
        ),
      onSome: (nanos) => Effect.succeed(nanos)
    })
})

/**
 * Decodes a `number` of milliseconds into a `Duration` and encodes a `Duration`
 * back to milliseconds.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to decode timeouts, delays, elapsed
 * intervals, or other duration values stored as millisecond counts.
 *
 * **Details**
 *
 * Decode creates a duration from the number, and encode returns the duration
 * length in milliseconds.
 *
 * **Example** (Converting milliseconds to a Duration)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.Number.pipe(
 *   Schema.decodeTo(Schema.Duration, SchemaTransformation.durationFromMillis)
 * )
 * ```
 *
 * @see {@link durationFromNanos}
 *
 * @category transforming
 * @since 4.0.0
 */
export const durationFromMillis: Transformation<Duration.Duration, number> = transform({
  decode: (i) => Duration.millis(i),
  encode: (a) => Duration.toMillis(a)
})

type JsonError = {
  message: string
  name?: string
  stack?: string
  cause?: Json
}

const isJsonError = (input: unknown): input is JsonError =>
  Predicate.isObject(input) && typeof input["message"] === "string"

const decodeJsonError = (input: JsonError): Error => {
  const hasCause = Object.hasOwn(input, "cause")
  const err = hasCause
    ? new Error(input.message, { cause: decodeDefect(input.cause as Json) })
    : new Error(input.message)
  if (typeof input.name === "string" && input.name !== "Error") err.name = input.name
  if (typeof input.stack === "string") err.stack = input.stack
  return err
}

const encodeUnknownAsJson = (input: unknown): Json => {
  try {
    const json = formatJson(input)
    return json === undefined ? format(input) : JSON.parse(json)
  } catch {
    return format(input)
  }
}

const encodeJsonError = (
  input: Error,
  options: ErrorOptions | undefined,
  encodeDefect: (input: unknown) => Json
): JsonError => {
  const encoded: JsonError = {
    name: input.name,
    message: typeof input.message === "string" ? input.message : ""
  }
  if (options?.includeStack && typeof input.stack === "string") {
    encoded.stack = input.stack
  }
  if (!options?.excludeCause && input.cause !== undefined) {
    encoded.cause = encodeDefect(input.cause)
  }
  return encoded
}

const makeEncodeDefect = (options?: ErrorOptions): (input: unknown) => Json => {
  const seen = new WeakSet<object>()
  const encode = (input: unknown): Json => {
    if (Predicate.isError(input)) {
      if (seen.has(input)) {
        return "[Circular]"
      }
      seen.add(input)
      const encoded = encodeJsonError(input, options, encode)
      seen.delete(input)
      return encoded
    }
    return encodeUnknownAsJson(input)
  }
  return encode
}

const decodeDefect = (input: Json): unknown => isJsonError(input) ? decodeJsonError(input) : input

/** @internal */
export const errorFromJsonError = (options?: ErrorOptions): Transformation<Error, JsonError> =>
  transform({
    decode: decodeJsonError,
    encode: (input) => makeEncodeDefect(options)(input) as JsonError
  })

/** @internal */
export const defectFromJson = (options?: ErrorOptions) =>
  transform({
    decode: decodeDefect,
    encode: makeEncodeDefect(options)
  })

/**
 * Decodes `T | null` into `Option<T>` and encodes `Option<T>` back to
 * `T | null`.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to convert nullable API fields to
 * `Option`.
 *
 * **Details**
 *
 * Decoding maps `null` to `Option.none()` and non-null values to
 * `Option.some(value)`. Encoding maps `Option.none()` to `null` and
 * `Option.some(value)` to `value`. The transformation is pure and synchronous.
 *
 * **Example** (Converting nullable values to an Option)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.NullOr(Schema.String).pipe(
 *   Schema.decodeTo(
 *     Schema.Option(Schema.String),
 *     SchemaTransformation.optionFromNullOr()
 *   )
 * )
 * ```
 *
 * @see {@link optionFromNullishOr}
 *
 * @category transforming
 * @since 4.0.0
 */
export function optionFromNullOr<T>(): Transformation<Option.Option<T>, T | null> {
  return transform({
    decode: Option.fromNullOr,
    encode: Option.getOrNull
  })
}

/**
 * Decodes `T | undefined` into `Option<T>` and encodes `Option.none()` back to
 * `undefined`.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to convert API fields that use
 * `undefined` for absence to `Option`.
 *
 * **Details**
 *
 * Decoding maps `undefined` to `Option.none()` and non-undefined values to
 * `Option.some(value)`. Encoding maps `Option.none()` to `undefined` and
 * `Option.some(value)` to `value`. The transformation is pure and synchronous.
 *
 * **Example** (Converting undefined-or values to an Option)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.UndefinedOr(Schema.String).pipe(
 *   Schema.decodeTo(
 *     Schema.Option(Schema.String),
 *     SchemaTransformation.optionFromUndefinedOr()
 *   )
 * )
 * ```
 *
 * @see {@link optionFromOptionalKey}
 * @see {@link optionFromOptional}
 *
 * @category transforming
 * @since 4.0.0
 */
export function optionFromUndefinedOr<T>(): Transformation<Option.Option<T>, T | undefined> {
  return transform({
    decode: Option.fromUndefinedOr,
    encode: Option.getOrUndefined
  })
}

/**
 * Decodes `T | null | undefined` into `Option<T>` and encodes `Option<T>`
 * back to `T | null` or `T | undefined` depending on the provided
 * `options.onNoneEncoding` (defaults to `undefined`).
 *
 * **When to use**
 *
 * Use when you need a schema transformation to convert nullish API fields to
 * `Option` when both `null` and `undefined` represent absence.
 *
 * **Details**
 *
 * Decoding maps `null` and `undefined` to `Option.none()` and all other values
 * to `Option.some(value)`. Encoding maps `Option.none()` to `null` or
 * `undefined` according to `options.onNoneEncoding`, and maps
 * `Option.some(value)` to `value`. The transformation is pure and synchronous.
 *
 * **Example** (Converting nullish values to an Option and encoding None as null)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.NullishOr(Schema.String).pipe(
 *   Schema.decodeTo(
 *     Schema.Option(Schema.String),
 *     SchemaTransformation.optionFromNullishOr({ onNoneEncoding: null })
 *   )
 * )
 * ```
 *
 * @see {@link optionFromNullOr}
 * @see {@link optionFromUndefinedOr}
 *
 * @category transforming
 * @since 4.0.0
 */
export function optionFromNullishOr<T>(
  options?: {
    onNoneEncoding: null | undefined
  }
): Transformation<Option.Option<T>, T | null | undefined> {
  return transform({
    decode: Option.fromNullishOr,
    encode: options?.onNoneEncoding === null ? Option.getOrNull : Option.getOrUndefined
  })
}

/**
 * Decodes an optional struct key into `Option<T>` and encodes `Option<T>`
 * back to an optional key.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to convert optional struct keys
 * (declared with `Schema.optionalKey`) to `Option` values.
 *
 * **Details**
 *
 * Decoding maps an absent key (`None`) to `Some(None)` and a present key
 * (`Some(v)`) to `Some(Some(v))`. Encoding maps `Some(None)` to `None` to omit
 * the key, and maps `Some(Some(v))` to `Some(v)`. This uses
 * `transformOptional` under the hood.
 *
 * **Example** (Converting an optional key to an Option)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.Struct({
 *   name: Schema.optionalKey(Schema.String).pipe(
 *     Schema.decodeTo(
 *       Schema.Option(Schema.String),
 *       SchemaTransformation.optionFromOptionalKey()
 *     )
 *   )
 * })
 * ```
 *
 * @see {@link optionFromOptional}
 * @see {@link optionFromUndefinedOr}
 * @see {@link transformOptional}
 *
 * @category transforming
 * @since 4.0.0
 */
export function optionFromOptionalKey<T>(): Transformation<Option.Option<T>, T> {
  return transformOptional({
    decode: Option.some,
    encode: Option.flatten
  })
}

/**
 * Decodes optional values into `Option<T>` and encodes `Option.none()` back to
 * an omitted optional value.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to convert optional (possibly
 * `undefined`) values to `Option`.
 *
 * **Details**
 *
 * Decoding maps an absent or `undefined` value to `Some(None)` and a present
 * value to `Some(Some(v))`. Encoding maps `Some(None)` to `None` to omit the
 * value, and maps `Some(Some(v))` to `Some(v)`. This uses
 * `transformOptional` under the hood and filters out `undefined` on decode.
 *
 * **Example** (Converting an optional value to an Option)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.Struct({
 *   age: Schema.optional(Schema.Number).pipe(
 *     Schema.decodeTo(
 *       Schema.Option(Schema.Number),
 *       SchemaTransformation.optionFromOptional()
 *     )
 *   )
 * })
 * ```
 *
 * @see {@link optionFromOptionalKey}
 * @see {@link optionFromUndefinedOr}
 * @see {@link transformOptional}
 *
 * @category transforming
 * @since 4.0.0
 */
export function optionFromOptional<T>(): Transformation<Option.Option<T>, T | undefined> {
  return transformOptional<Option.Option<T>, T | undefined>({
    decode: (ot) => ot.pipe(Option.filter(Predicate.isNotUndefined), Option.some),
    encode: Option.flatten
  })
}

/**
 * Decodes a `string` into a `URL` and encodes a `URL` back to its `href`
 * string.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to parse URL strings from user
 * input or API responses.
 *
 * **Details**
 *
 * Decoding checks `URL.canParse(s)` and fails with `InvalidValue` if the string
 * is not a valid URL. Encoding returns `url.href`.
 *
 * **Example** (Converting a string to a URL)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.URL, SchemaTransformation.urlFromString)
 * )
 * ```
 *
 * @see {@link numberFromString}
 * @see {@link transformOrFail}
 *
 * @category transforming
 * @since 4.0.0
 */
export const urlFromString: Transformation<URL, string> = transformOrFail<URL, string>({
  decode: (s) =>
    URL.canParse(s)
      ? Effect.succeed(new URL(s))
      : Effect.fail(new SchemaIssue.InvalidValue(Option.some(s), { message: `Invalid URL string: ${s}` })),
  encode: (url) => Effect.succeed(url.href)
})

/**
 * Decodes a `string` into a `BigDecimal` and encodes a `BigDecimal` back to
 * its string representation.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to parse decimal number strings
 * from APIs or user input.
 *
 * **Details**
 *
 * Decoding calls `BigDecimal.fromString(s)` and fails with `InvalidValue` if
 * the string is not a valid `BigDecimal` representation. Encoding returns
 * `BigDecimal.format(bd)`.
 *
 * @category transforming
 * @since 4.0.0
 */
export const bigDecimalFromString: Transformation<BigDecimal.BigDecimal, string> = transformOrFail<
  BigDecimal.BigDecimal,
  string
>({
  decode: (s) => {
    const result = BigDecimal.fromString(s)
    return Option.isNone(result)
      ? Effect.fail(new SchemaIssue.InvalidValue(Option.some(s), { message: `Invalid BigDecimal string: ${s}` }))
      : Effect.succeed(result.value)
  },
  encode: (bd) => Effect.succeed(BigDecimal.format(bd))
})

/**
 * Decodes a Base64-encoded `string` into a `Uint8Array` and encodes a
 * `Uint8Array` back to a Base64 string.
 *
 * **When to use**
 *
 * Use when you need a schema transformation for binary data transmitted as
 * Base64 strings (e.g. file uploads, API payloads).
 *
 * **Details**
 *
 * Decoding parses the Base64 string into bytes. Encoding writes the byte array
 * as a Base64 string.
 *
 * **Example** (Converting Base64 to a Uint8Array)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Uint8Array, SchemaTransformation.uint8ArrayFromBase64String)
 * )
 * ```
 *
 * @see {@link fromJsonString}
 * @see `Schema.Uint8ArrayFromBase64` - a ready-made schema wrapping this transformation.
 *
 * @category encoding
 * @since 4.0.0
 */
export const uint8ArrayFromBase64String: Transformation<Uint8Array<ArrayBufferLike>, string> = new Transformation(
  SchemaGetter.decodeBase64(),
  SchemaGetter.encodeBase64()
)

/**
 * Decodes a Base64-encoded `string` into a UTF-8 `string` and encodes a
 * UTF-8 `string` back to a Base64 string.
 *
 * **When to use**
 *
 * Use when you need a schema transformation for text data transmitted as Base64
 * strings.
 *
 * **Details**
 *
 * Decoding parses the Base64 string into a UTF-8 string. Encoding writes the
 * string as a Base64 string.
 *
 * **Example** (Converting Base64 to a string)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.String, SchemaTransformation.stringFromBase64String)
 * )
 * ```
 *
 * @see {@link uint8ArrayFromBase64String}
 * @see `Schema.StringFromBase64` - a ready-made schema wrapping this transformation.
 *
 * @category encoding
 * @since 4.0.0
 */
export const stringFromBase64String: Transformation<string, string> = new Transformation(
  SchemaGetter.decodeBase64String(),
  SchemaGetter.encodeBase64()
)

/**
 * Decodes a base64 (URL) encoded `string` into a UTF-8 `string` and encodes it back.
 *
 * **When to use**
 *
 * Use when you need a schema transformation for text data transmitted as Base64
 * URL-safe strings.
 *
 * **Details**
 *
 * Decoding parses the Base64 URL string into a UTF-8 string. Encoding writes
 * the string as a Base64 URL string.
 *
 * **Example** (Converting Base64Url to a string)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.String, SchemaTransformation.stringFromBase64UrlString)
 * )
 * ```
 *
 * @see {@link stringFromBase64String}
 * @see `Schema.StringFromBase64Url` - a ready-made schema wrapping this transformation.
 *
 * @category encoding
 * @since 4.0.0
 */
export const stringFromBase64UrlString: Transformation<string, string> = new Transformation(
  SchemaGetter.decodeBase64UrlString(),
  SchemaGetter.encodeBase64Url()
)

/**
 * Decodes a hex encoded `string` into a UTF-8 `string` and encodes it back.
 *
 * **When to use**
 *
 * Use when you need a schema transformation for text data transmitted as
 * hexadecimal strings.
 *
 * **Details**
 *
 * Decoding parses the hex string into a UTF-8 string. Encoding writes the
 * string as a hex string.
 *
 * **Example** (Converting hex to a string)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.String, SchemaTransformation.stringFromHexString)
 * )
 * ```
 *
 * @see {@link stringFromBase64String}
 * @see `Schema.StringFromHex` - a ready-made schema wrapping this transformation.
 *
 * @category encoding
 * @since 4.0.0
 */
export const stringFromHexString: Transformation<string, string> = new Transformation(
  SchemaGetter.decodeHexString(),
  SchemaGetter.encodeHex()
)

/**
 * Decodes a URI component encoded string into a UTF-8 string and encodes a
 * UTF-8 string into a URI component encoded string.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to store structured data in URL
 * query parameters or fragments, such as composing with `Schema.parseJson` to
 * round-trip JSON through a URL.
 *
 * **Details**
 *
 * Decoding calls `decodeURIComponent` and fails if the input contains malformed
 * percent-encoding sequences. Encoding calls `encodeURIComponent`.
 *
 * **Example** (Defining a URI component schema)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.String, SchemaTransformation.stringFromUriComponent)
 * )
 * ```
 *
 * @see {@link stringFromBase64String}
 * @see `Schema.StringFromUriComponent` - a ready-made schema wrapping this transformation.
 *
 * @category encoding
 * @since 4.0.0
 */
export const stringFromUriComponent: Transformation<string, string> = new Transformation(
  SchemaGetter.decodeUriComponent(),
  SchemaGetter.encodeUriComponent()
)

/**
 * Decodes a JSON string with `JSON.parse` and encodes a value with
 * `JSON.stringify`.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to decode JSON stored or
 * transmitted as a string, usually before composing with another schema that
 * validates the parsed structure.
 *
 * **Details**
 *
 * Decode fails with `InvalidValue` for invalid JSON, and encode can fail with
 * `InvalidValue` when `JSON.stringify` cannot serialize the value.
 *
 * **Example** (Parsing JSON)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString)
 * )
 * ```
 *
 * @see {@link uint8ArrayFromBase64String}
 * @see {@link fromFormData}
 *
 * @category decoding
 * @since 4.0.0
 */
export const fromJsonString = new Transformation<unknown, string>(
  SchemaGetter.parseJson(),
  SchemaGetter.stringifyJson()
)

/**
 * Decodes a `FormData` instance into a nested record using bracket-path keys and
 * encodes object-like values back into `FormData`.
 *
 * **When to use**
 *
 * Use when you need a schema transformation for form or multipart payloads
 * whose keys, such as `user[name]` or `items[0]`, should become nested data.
 *
 * **Details**
 *
 * Decode preserves string and `Blob` leaves. Encode flattens nested objects and
 * arrays into bracket-path entries and returns an empty `FormData` for
 * non-object inputs.
 *
 * **Example** (Decoding FormData)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.instanceOf(FormData).pipe(
 *   Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromFormData)
 * )
 * ```
 *
 * @see {@link fromURLSearchParams}
 * @see {@link fromJsonString}
 *
 * @category decoding
 * @since 4.0.0
 */
export const fromFormData = new Transformation<unknown, FormData>(
  SchemaGetter.decodeFormData(),
  SchemaGetter.encodeFormData()
)

/**
 * Decodes `URLSearchParams` into a nested record using bracket-path keys and
 * encodes object-like values back into `URLSearchParams`.
 *
 * **When to use**
 *
 * Use when you need a schema transformation for query strings whose keys, such
 * as `filter[name]` or `items[0]`, should become nested data.
 *
 * **Details**
 *
 * Decode produces string leaves. Encode flattens nested objects and arrays into
 * bracket-path entries and returns empty `URLSearchParams` for non-object
 * inputs.
 *
 * **Example** (Decoding URLSearchParams)
 *
 * ```ts
 * import { Schema, SchemaTransformation } from "effect"
 *
 * const schema = Schema.instanceOf(URLSearchParams).pipe(
 *   Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromURLSearchParams)
 * )
 * ```
 *
 * @see {@link fromFormData}
 * @see {@link fromJsonString}
 *
 * @category decoding
 * @since 4.0.0
 */
export const fromURLSearchParams = new Transformation<unknown, URLSearchParams>(
  SchemaGetter.decodeURLSearchParams(),
  SchemaGetter.encodeURLSearchParams()
)

/**
 * Decodes a numeric time-zone offset in milliseconds into a
 * `DateTime.TimeZone.Offset` and encodes it back to the offset number.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to represent fixed-offset time
 * zones with numeric millisecond offsets.
 *
 * **Details**
 *
 * Decode uses `DateTime.zoneMakeOffset`; encode returns the offset's `offset`
 * field.
 *
 * @see {@link timeZoneFromString} for IANA or offset string encodings
 * @see {@link timeZoneNamedFromString} for IANA named-zone strings
 *
 * @category transforming
 * @since 4.0.0
 */
export const timeZoneOffsetFromNumber: Transformation<DateTime.TimeZone.Offset, number> = transform<
  DateTime.TimeZone.Offset,
  number
>({
  decode: (n) => DateTime.zoneMakeOffset(n),
  encode: (tz) => tz.offset
})

/**
 * Decodes an IANA time-zone identifier string into a
 * `DateTime.TimeZone.Named` and encodes a named time zone back to its `id`.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to accept only IANA time-zone
 * identifier strings and produce `DateTime.TimeZone.Named` values.
 *
 * **Details**
 *
 * Decode fails with `InvalidValue` when the string is not a valid IANA time-zone
 * identifier.
 *
 * @see {@link timeZoneFromString} for time-zone strings that may be either IANA identifiers or offset strings
 *
 * @category transforming
 * @since 4.0.0
 */
export const timeZoneNamedFromString: Transformation<DateTime.TimeZone.Named, string> = transformOrFail<
  DateTime.TimeZone.Named,
  string
>({
  decode: (s) => {
    return Option.match(DateTime.zoneMakeNamed(s), {
      onNone: () =>
        Effect.fail(new SchemaIssue.InvalidValue(Option.some(s), { message: `Invalid IANA time zone: ${s}` })),
      onSome: Effect.succeed
    })
  },
  encode: (tz) => Effect.succeed(tz.id)
})

/**
 * Decodes a string into a `DateTime.TimeZone` and encodes a time zone back to
 * its string representation.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to accept either an IANA time-zone
 * identifier or an offset string and produce a general `DateTime.TimeZone`.
 *
 * **Details**
 *
 * Accepted decode inputs include valid IANA identifiers and offset strings such
 * as `"+03:00"`. Decode fails with `InvalidValue` when the string cannot be
 * parsed as a time zone.
 *
 * @see {@link timeZoneNamedFromString} for IANA named-zone strings only
 * @see {@link timeZoneOffsetFromNumber} for fixed-offset zones encoded as numbers
 *
 * @category transforming
 * @since 4.0.0
 */
export const timeZoneFromString: Transformation<DateTime.TimeZone, string> = transformOrFail<
  DateTime.TimeZone,
  string
>({
  decode: (s) => {
    return Option.match(DateTime.zoneFromString(s), {
      onNone: () => Effect.fail(new SchemaIssue.InvalidValue(Option.some(s), { message: `Invalid time zone: ${s}` })),
      onSome: Effect.succeed
    })
  },
  encode: (tz) => Effect.succeed(DateTime.zoneToString(tz))
})

/**
 * Decodes a date-time string into a `DateTime.Utc` and encodes it back to an ISO
 * string.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to decode date-time strings to a
 * normalized `DateTime.Utc` and encode back as a UTC ISO string.
 *
 * **Details**
 *
 * Decode accepts strings supported by `DateTime.make`, converts the result to
 * UTC, and fails with `InvalidValue` when parsing fails. Encode uses
 * `DateTime.formatIso`.
 *
 * @see {@link dateFromString} for decoding into JavaScript `Date`
 * @see {@link dateTimeZonedFromString} for ISO strings that should preserve zoned date-time information
 *
 * @category transforming
 * @since 4.0.0
 */
export const dateTimeUtcFromString: Transformation<DateTime.Utc, string> = transformOrFail<
  DateTime.Utc,
  string
>({
  decode: (s) => {
    return Option.match(DateTime.make(s), {
      onNone: () =>
        Effect.fail(new SchemaIssue.InvalidValue(Option.some(s), { message: `Invalid UTC DateTime string: ${s}` })),
      onSome: (result) => Effect.succeed(DateTime.toUtc(result))
    })
  },
  encode: (utc) => Effect.succeed(DateTime.formatIso(utc))
})

/**
 * Decodes a zoned date-time string into a `DateTime.Zoned` and encodes it back
 * to an ISO zoned string.
 *
 * **When to use**
 *
 * Use when you need a schema transformation for ISO zoned date-time strings
 * that decode to `DateTime.Zoned` and encode with `DateTime.formatIsoZoned`.
 *
 * **Details**
 *
 * Decode uses `DateTime.makeZonedFromString` and fails with `InvalidValue` when
 * the input is not a valid zoned date-time. Encode uses
 * `DateTime.formatIsoZoned`.
 *
 * @see {@link dateTimeUtcFromString} for date-time strings that should decode to `DateTime.Utc` and encode as UTC ISO strings
 *
 * @category transforming
 * @since 4.0.0
 */
export const dateTimeZonedFromString: Transformation<DateTime.Zoned, string> = transformOrFail<
  DateTime.Zoned,
  string
>({
  decode: (s) => {
    return Option.match(DateTime.makeZonedFromString(s), {
      onNone: () =>
        Effect.fail(new SchemaIssue.InvalidValue(Option.some(s), { message: `Invalid Zoned DateTime string: ${s}` })),
      onSome: Effect.succeed
    })
  },
  encode: (zoned) => Effect.succeed(DateTime.formatIsoZoned(zoned))
})
