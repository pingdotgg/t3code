/**
 * Composable transformation primitives for the Effect Schema system.
 *
 * A `Getter<T, E, R>` represents a single-direction transformation from an
 * encoded type `E` to a decoded type `T`. Getters are the building blocks
 * that `Schema.decodeTo` and `Schema.decode` use to define how values are
 * transformed during encoding and decoding. They handle optionality
 * (`Option<E>` in, `Option<T>` out), can fail with `Issue`, and can require
 * Effect services via `R`.
 *
 * ## Mental model
 *
 * - **Getter**: A function `Option<E> -> Effect<Option<T>, Issue, R>`. It
 *   transforms an optional encoded value into an optional decoded value,
 *   possibly failing or requiring services.
 * - **Passthrough**: The identity getter — returns the input unchanged. Used
 *   when no transformation is needed. Optimized away during composition.
 * - **Option-awareness**: Getters receive and return `Option` to handle
 *   missing keys in structs. `Option.None` means the key is absent.
 * - **Composition**: Getters compose left-to-right via `.compose()`. A
 *   passthrough on either side is a no-op (identity optimization).
 * - **Issue**: The error type for all getter failures (see `SchemaIssue`).
 *
 * ## Common tasks
 *
 * - Pass a value through unchanged → {@link passthrough}
 * - Transform a value purely → {@link transform}
 * - Transform a value with possible failure → {@link transformOrFail}
 * - Transform with full Option control → {@link transformOptional}
 * - Handle missing keys → {@link onNone}, {@link required}, {@link withDefault}
 * - Handle present values → {@link onSome}
 * - Validate a value with an effectful check → {@link checkEffect}
 * - Produce a constant value → {@link succeed}
 * - Always fail → {@link fail}, {@link forbidden}
 * - Omit a value from output → {@link omit}
 * - Coerce to a primitive type → {@link String}, {@link Number}, {@link Boolean}, {@link BigInt}, {@link Date}
 * - Transform strings → {@link trim}, {@link capitalize}, {@link toLowerCase}, {@link toUpperCase}, {@link split}, {@link splitKeyValue}, {@link joinKeyValue}
 * - Parse/stringify JSON → {@link parseJson}, {@link stringifyJson}
 * - Encode/decode Base64 → {@link encodeBase64}, {@link decodeBase64}, {@link decodeBase64String}
 * - Encode/decode Hex → {@link encodeHex}, {@link decodeHex}, {@link decodeHexString}
 * - Encode/decode URI components → {@link encodeUriComponent}, {@link decodeUriComponent}
 * - Parse DateTime → {@link dateTimeUtcFromInput}
 * - Decode/encode FormData → {@link decodeFormData}, {@link encodeFormData}
 * - Decode/encode URLSearchParams → {@link decodeURLSearchParams}, {@link encodeURLSearchParams}
 * - Build nested tree from bracket paths → {@link makeTreeRecord}
 * - Flatten nested tree to bracket paths → {@link collectBracketPathEntries}
 *
 * ## Gotchas
 *
 * - Getters are not bidirectional. To define a full encode/decode pair, supply
 *   both a `decode` and an `encode` getter to `Schema.decodeTo`.
 * - `passthrough` requires `T === E` by default. Use `{ strict: false }` to
 *   bypass the type constraint, or use {@link passthroughSupertype} / {@link passthroughSubtype}.
 * - `transform` skips `None` inputs (missing keys) — the function is only
 *   called when a value is present. Use `transformOptional` if you need to
 *   handle missing values.
 * - `parseJson` without a `reviver` returns `Schema.MutableJson`. With a
 *   reviver, the return type widens to `unknown`.
 * - `split` treats an empty string as an empty array, not `[""]`.
 *
 * ## Quickstart
 *
 * **Example** (Using SchemaGetter with Schema.decodeTo)
 *
 * ```ts
 * import { Schema, SchemaGetter } from "effect"
 *
 * const NumberFromString = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Number, {
 *     decode: SchemaGetter.transform((s) => Number(s)),
 *     encode: SchemaGetter.transform((n) => String(n))
 *   })
 * )
 *
 * const result = Schema.decodeUnknownSync(NumberFromString)("42")
 * // result: 42
 * ```
 *
 * ## See also
 *
 * - {@link Getter} — the core class
 * - {@link transform} — most common constructor
 * - {@link passthrough} — identity getter
 * - {@link transformOrFail} — fallible transformation
 *
 * @since 4.0.0
 */
import * as DateTime from "./DateTime.ts"
import * as Effect from "./Effect.ts"
import * as Encoding from "./Encoding.ts"
import * as Option from "./Option.ts"
import * as Pipeable from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import * as Result from "./Result.ts"
import type * as Schema from "./Schema.ts"
import type * as AST from "./SchemaAST.ts"
import * as Issue from "./SchemaIssue.ts"
import * as Str from "./String.ts"

/**
 * Represents a composable transformation from an encoded type `E` to a decoded type `T`.
 *
 * **When to use**
 *
 * Use to build custom schema transformations with `Schema.decodeTo` or `Schema.decode`.
 * - Composing multiple transformation steps into a single getter.
 *
 * **Details**
 *
 * - A getter wraps a function `Option<E> -> Effect<Option<T>, Issue, R>`.
 * - Receives `Option.None` when the encoded key is absent (e.g. missing struct field).
 * - Returns `Option.None` to omit the value from the decoded output.
 * - Fails with `Issue` on invalid input.
 * - May require Effect services via `R`.
 * - `.map(f)` applies `f` to the decoded value (inside the `Some`), leaving `None` unchanged.
 * - `.compose(other)` chains two getters: the output of `this` feeds into `other`.
 *   Passthrough getters on either side are optimized away.
 *
 * **Example** (Creating and composing getters)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const parseNumber = SchemaGetter.transform<number, string>((s) => Number(s))
 * const double = SchemaGetter.transform<number, number>((n) => n * 2)
 * const composed = parseNumber.compose(double)
 * // composed: Getter<number, string> — parses then doubles
 * ```
 *
 * @see {@link transform} to create a getter from a pure function
 * @see {@link passthrough} for the identity getter
 * @see {@link transformOrFail} for fallible transformation
 *
 * @category models
 * @since 4.0.0
 */
export class Getter<out T, in E, R = never> extends Pipeable.Class {
  readonly run: (
    input: Option.Option<E>,
    options: AST.ParseOptions
  ) => Effect.Effect<Option.Option<T>, Issue.Issue, R>

  constructor(
    run: (
      input: Option.Option<E>,
      options: AST.ParseOptions
    ) => Effect.Effect<Option.Option<T>, Issue.Issue, R>
  ) {
    super()
    this.run = run
  }
  map<T2>(f: (t: T) => T2): Getter<T2, E, R> {
    return new Getter((oe, options) => this.run(oe, options).pipe(Effect.mapEager(Option.map(f))))
  }
  compose<T2, R2>(other: Getter<T2, T, R2>): Getter<T2, E, R | R2> {
    if (isPassthrough(this)) {
      return other as any
    }
    if (isPassthrough(other)) {
      return this as any
    }
    return new Getter((oe, options) => this.run(oe, options).pipe(Effect.flatMapEager((ot) => other.run(ot, options))))
  }
}

/**
 * Creates a getter that always produces the given constant value, ignoring the input.
 *
 * **When to use**
 *
 * Use when a schema field should always decode to a fixed value.
 * - You need a placeholder getter that produces a known default.
 *
 * **Details**
 *
 * - Pure, no side effects.
 * - Always returns `Option.some(t)` regardless of whether input is `Some` or `None`.
 *
 * **Example** (Constant getter)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const alwaysZero = SchemaGetter.succeed(0)
 * // alwaysZero: Getter<0, unknown> — always produces 0
 * ```
 *
 * @see {@link transform} when you need to use the input value
 * @see {@link passthrough} when you want to keep the input as-is
 *
 * @category constructors
 * @since 4.0.0
 */
export function succeed<const T, E>(t: T): Getter<T, E> {
  return new Getter(() => Effect.succeedSome(t))
}

/**
 * Creates a getter that always fails with the given issue.
 *
 * **When to use**
 *
 * Use when a transformation should unconditionally reject input.
 * - Building custom validation getters that produce specific error types.
 *
 * **Details**
 *
 * - Always fails with the `Issue` returned by `f`.
 * - The failure function receives the original `Option<E>` input for error context.
 *
 * **Example** (Always-failing getter)
 *
 * ```ts
 * import { Option, SchemaGetter, SchemaIssue } from "effect"
 *
 * const rejectAll = SchemaGetter.fail<string, string>(
 *   (oe) => new SchemaIssue.InvalidValue(oe, { message: "not allowed" })
 * )
 * ```
 *
 * @see {@link forbidden} for a convenience helper for `Forbidden` issues
 * @see {@link checkEffect} to fail conditionally based on input value
 *
 * @category constructors
 * @since 4.0.0
 */
export function fail<T, E>(f: (oe: Option.Option<E>) => Issue.Issue): Getter<T, E> {
  return new Getter((oe) => Effect.fail(f(oe)))
}

/**
 * Creates a getter that always fails with a `Forbidden` issue.
 *
 * **When to use**
 *
 * Use when a field or direction (encode/decode) should be disallowed entirely.
 * - You want a clear "forbidden" error message in schema validation output.
 *
 * **Details**
 *
 * - Always fails with `Issue.Forbidden`.
 * - The message function receives the `Option<E>` input for context.
 *
 * **Example** (Forbidding a decode direction)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const noEncode = SchemaGetter.forbidden<string, number>(
 *   () => "encoding is not supported"
 * )
 * ```
 *
 * @see {@link fail} to fail with a custom issue type
 *
 * @category constructors
 * @since 4.0.0
 */
export function forbidden<T, E>(message: (oe: Option.Option<E>) => string): Getter<T, E> {
  return fail<T, E>((oe) => new Issue.Forbidden(oe, { message: message(oe) }))
}

const passthrough_ = new Getter<any, any>(Effect.succeed)

function isPassthrough<T, E, R>(getter: Getter<T, E, R>): getter is typeof passthrough_ {
  return getter.run === passthrough_.run
}

/**
 * Returns the identity getter — passes the value through unchanged.
 *
 * **When to use**
 *
 * Use when no transformation is needed between encoded and decoded types.
 * - One side of a `decodeTo` pair (encode or decode) should be a no-op.
 *
 * **Details**
 *
 * - Pure, no allocation (singleton instance).
 * - Optimized away during `.compose()` — composing with a passthrough is free.
 * - The default overload requires `T === E`. Pass `{ strict: false }` to opt
 *   out of the type constraint.
 *
 * **Example** (Identity transformation)
 *
 * ```ts
 * import { Schema, SchemaGetter } from "effect"
 *
 * // No transformation needed — types already match
 * const StringToString = Schema.String.pipe(
 *   Schema.decodeTo(Schema.String, {
 *     decode: SchemaGetter.passthrough(),
 *     encode: SchemaGetter.passthrough()
 *   })
 * )
 * ```
 *
 * @see {@link passthroughSupertype} when `T extends E`
 * @see {@link passthroughSubtype} when `E extends T`
 * @see {@link transform} when you need to change the value
 *
 * @category constructors
 * @since 4.0.0
 */
export function passthrough<T, E>(options: { readonly strict: false }): Getter<T, E>
export function passthrough<T>(): Getter<T, T>
export function passthrough<T>(): Getter<T, T> {
  return passthrough_
}

/**
 * Returns the identity getter typed for the relationship `T extends E`.
 *
 * **When to use**
 *
 * Use when no runtime conversion is needed but the getter should be typed
 * as producing a decoded/output type that is narrower than the encoded/input
 * type.
 *
 * **Details**
 *
 * - Same singleton as {@link passthrough} — no allocation, optimized in composition.
 *
 * **Example** (Supertype passthrough)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * // string extends string, so this is valid
 * const g = SchemaGetter.passthroughSupertype<string, string>()
 * ```
 *
 * @see {@link passthrough} when types are identical
 * @see {@link passthroughSubtype} when `E extends T`
 *
 * @category constructors
 * @since 4.0.0
 */
export function passthroughSupertype<T extends E, E>(): Getter<T, E>
export function passthroughSupertype<T>(): Getter<T, T> {
  return passthrough_
}

/**
 * Returns the identity getter, typed for when the encoded type `E` is a subtype of `T`.
 *
 * **When to use**
 *
 * Use when the encoded type is narrower than the decoded type.
 * - You need type-safe passthrough without `{ strict: false }`.
 *
 * **Details**
 *
 * - Same singleton as {@link passthrough} — no allocation, optimized in composition.
 *
 * **Example** (Subtype passthrough)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * // "hello" extends string, so E extends T
 * const g = SchemaGetter.passthroughSubtype<string, "hello">()
 * ```
 *
 * @see {@link passthrough} when types are identical
 * @see {@link passthroughSupertype} when `T extends E`
 *
 * @category constructors
 * @since 4.0.0
 */
export function passthroughSubtype<T, E extends T>(): Getter<T, E>
export function passthroughSubtype<T>(): Getter<T, T> {
  return passthrough_
}

/**
 * Creates a getter that handles the case when the input is absent (`Option.None`).
 *
 * **When to use**
 *
 * Use when you need to provide a fallback or computed value for missing struct keys.
 * - Building custom "default value" logic more complex than {@link withDefault}.
 *
 * **Details**
 *
 * - When input is `None`, calls `f` to produce the result.
 * - When input is `Some`, passes it through unchanged.
 * - `f` receives the parse options and may return `None` to keep the value absent.
 *
 * **Example** (Default timestamp for missing field)
 *
 * ```ts
 * import { Effect, Option, SchemaGetter } from "effect"
 *
 * const withTimestamp = SchemaGetter.onNone<number>(() =>
 *   Effect.succeed(Option.some(Date.now()))
 * )
 * ```
 *
 * @see {@link required} when absent input should fail
 * @see {@link withDefault} for a simpler default value for undefined inputs
 * @see {@link onSome} to handle only present values
 *
 * @category constructors
 * @since 4.0.0
 */
export function onNone<T, E extends T = T, R = never>(
  f: (options: AST.ParseOptions) => Effect.Effect<Option.Option<T>, Issue.Issue, R>
): Getter<T, E, R> {
  return new Getter((ot, options) => Option.isNone(ot) ? f(options) : Effect.succeed(ot))
}

/**
 * Creates a getter that fails with `MissingKey` if the input is absent (`Option.None`).
 *
 * **When to use**
 *
 * Use when a struct field must be present in the encoded input.
 * - You want schema validation to report a missing key error.
 *
 * **Details**
 *
 * - When input is `None`, fails with `Issue.MissingKey`.
 * - When input is `Some`, passes it through unchanged.
 * - Optional `annotations` customize the error message for the missing key.
 *
 * **Example** (Required struct field)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const mustExist = SchemaGetter.required<string>()
 * ```
 *
 * @see {@link onNone} to provide a fallback instead of failing
 * @see {@link withDefault} to substitute a default for undefined values
 *
 * @category constructors
 * @since 4.0.0
 */
export function required<T, E extends T = T>(annotations?: Schema.Annotations.Key<T>): Getter<T, E> {
  return onNone(() => Effect.fail(new Issue.MissingKey(annotations)))
}

/**
 * Creates a getter that handles present values (`Option.Some`), passing `None` through.
 *
 * **When to use**
 *
 * Use when you need to transform or validate only when a value is present.
 * - Missing keys should remain absent in the output.
 *
 * **Details**
 *
 * - When input is `None`, returns `None` (no-op).
 * - When input is `Some(e)`, calls `f(e, options)` to produce the result.
 * - `f` may return `None` to omit the value, or fail with an `Issue`.
 *
 * **Example** (Transform only present values)
 *
 * ```ts
 * import { Effect, Option, SchemaGetter } from "effect"
 *
 * const parseIfPresent = SchemaGetter.onSome<number, string>(
 *   (s) => Effect.succeed(Option.some(Number(s)))
 * )
 * ```
 *
 * @see {@link onNone} to handle only absent values
 * @see {@link transform} for a simpler pure transformation of present values
 * @see {@link transformOrFail} for fallible transformation of present values
 *
 * @category constructors
 * @since 4.0.0
 */
export function onSome<T, E, R = never>(
  f: (e: E, options: AST.ParseOptions) => Effect.Effect<Option.Option<T>, Issue.Issue, R>
): Getter<T, E, R> {
  return new Getter((oe, options) => Option.isNone(oe) ? Effect.succeedNone : f(oe.value, options))
}

/**
 * Creates a getter that validates a value using an effectful check function.
 *
 * **When to use**
 *
 * Use when you need to validate a decoded value (e.g. check a constraint or call an external service).
 * - The validation may be asynchronous or require Effect services.
 *
 * **Details**
 *
 * - Only runs when input is `Some` — `None` passes through.
 * - The check function returns a validation result:
 *   - `undefined` or `true` — value is valid, passes through.
 *   - `false` or a `string` — value is invalid, fails with an `Issue`.
 *   - An `Issue` object — fails with that issue directly.
 *   - `{ path, issue }` — fails with a nested path issue (`issue` may be a
 *     message string or a full {@link Issue.Issue}).
 * - Does not transform the value — input and output types are the same.
 *
 * **Example** (Effectful validation)
 *
 * ```ts
 * import { Effect, SchemaGetter } from "effect"
 *
 * const nonNegative = SchemaGetter.checkEffect<number>((n) =>
 *   Effect.succeed(n >= 0 ? undefined : "must be non-negative")
 * )
 * ```
 *
 * @see {@link transform} when you need to change the value, not just validate
 * @see {@link fail} for unconditional failure
 *
 * @category constructors
 * @since 4.0.0
 */
export function checkEffect<T, R = never>(
  f: (input: T, options: AST.ParseOptions) => Effect.Effect<
    undefined | boolean | Schema.FilterIssue,
    never,
    R
  >
): Getter<T, T, R> {
  return onSome((t, options) => {
    return f(t, options).pipe(Effect.flatMapEager((out) => {
      const issue = Issue.makeSingle(t, out)
      return issue ?
        Effect.fail(issue) :
        Effect.succeed(Option.some(t))
    }))
  })
}

/**
 * Creates a getter that applies a pure function to present values.
 *
 * **When to use**
 *
 * Use when you have a pure, infallible transformation between types.
 * - Building encode/decode pairs for `Schema.decodeTo`.
 *
 * **Details**
 *
 * - This is the most commonly used constructor.
 * - Transforms `Some(e)` to `Some(f(e))` and leaves `None` unchanged.
 * - Skips `None` inputs — only called when a value is present.
 * - Never fails.
 *
 * **Example** (String to number transformation pair)
 *
 * ```ts
 * import { Schema, SchemaGetter } from "effect"
 *
 * const NumberFromString = Schema.String.pipe(
 *   Schema.decodeTo(Schema.Number, {
 *     decode: SchemaGetter.transform((s) => Number(s)),
 *     encode: SchemaGetter.transform((n) => String(n))
 *   })
 * )
 * ```
 *
 * @see {@link transformOrFail} when the transformation can fail
 * @see {@link transformOptional} when you need to handle `None` inputs
 * @see {@link passthrough} when no transformation is needed
 *
 * @category constructors
 * @since 4.0.0
 */
export function transform<T, E>(f: (e: E) => T): Getter<T, E> {
  return transformOptional(Option.map(f))
}

/**
 * Creates a getter that applies a fallible, effectful transformation to present values.
 *
 * **When to use**
 *
 * Use when the transformation may fail (e.g. parsing, validation).
 * - The transformation needs Effect services or is async.
 *
 * **Details**
 *
 * - Skips `None` inputs — only called when a value is present.
 * - On success, wraps the result in `Some`.
 * - On failure, propagates the `Issue`.
 *
 * **Example** (Parsing with failure)
 *
 * ```ts
 * import { Effect, Option, SchemaGetter, SchemaIssue } from "effect"
 *
 * const safeParseInt = SchemaGetter.transformOrFail<number, string>(
 *   (s) => {
 *     const n = parseInt(s, 10)
 *     return isNaN(n)
 *       ? Effect.fail(new SchemaIssue.InvalidValue(Option.some(s), { message: "not an integer" }))
 *       : Effect.succeed(n)
 *   }
 * )
 * ```
 *
 * @see {@link transform} when transformation cannot fail
 * @see {@link onSome} when you need full `Option` control over the output
 *
 * @category constructors
 * @since 4.0.0
 */
export function transformOrFail<T, E, R = never>(
  f: (e: E, options: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): Getter<T, E, R> {
  return onSome((e, options) => f(e, options).pipe(Effect.mapEager(Option.some)))
}

/**
 * Creates a getter that transforms the full `Option` — both present and absent values.
 *
 * **When to use**
 *
 * Use when you need to handle both `Some` and `None` cases.
 * - You want to turn a present value into absent, or vice versa.
 *
 * **Details**
 *
 * - Pure, never fails.
 * - Receives the full `Option<E>` and must return `Option<T>`.
 *
 * **Example** (Filter out empty strings)
 *
 * ```ts
 * import { Option, SchemaGetter } from "effect"
 *
 * const skipEmpty = SchemaGetter.transformOptional<string, string>((o) =>
 *   Option.filter(o, (s) => s.length > 0)
 * )
 * ```
 *
 * @see {@link transform} when you only need to transform present values
 * @see {@link omit} when you always want `None`
 *
 * @category constructors
 * @since 4.0.0
 */
export function transformOptional<T, E>(f: (oe: Option.Option<E>) => Option.Option<T>): Getter<T, E> {
  return new Getter((oe) => Effect.succeed(f(oe)))
}

/**
 * Creates a getter that always returns `None`, effectively omitting the value from output.
 *
 * **When to use**
 *
 * Use when a field should be excluded during decoding or encoding.
 *
 * **Details**
 *
 * - Always returns `Option.None` regardless of input.
 * - Never fails.
 *
 * **Example** (Omit a field during encoding)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const omitField = SchemaGetter.omit<string>()
 * ```
 *
 * @see {@link transformOptional} when you want conditional omission
 * @see {@link forbidden} when you want to fail instead of silently omit
 *
 * @category constructors
 * @since 4.0.0
 */
export function omit<T>(): Getter<never, T> {
  return new Getter(() => Effect.succeedNone)
}

/**
 * Creates a getter that replaces `undefined` values with a default.
 *
 * **When to use**
 *
 * Use when a field may be `undefined` in the encoded input and should have a fallback.
 *
 * **Details**
 *
 * - If the input is `Some(undefined)` or `None`, produces `Some(T)`.
 * - If the input is `Some(value)` where value is not `undefined`, passes it through.
 * - `defaultValue` is an `Effect` that will be executed each time a default is needed.
 *
 * **Example** (Default value for optional field)
 *
 * ```ts
 * import { Effect, SchemaGetter } from "effect"
 *
 * const withZero = SchemaGetter.withDefault(Effect.succeed(0))
 * // Getter<number, number | undefined>
 * ```
 *
 * @see {@link onNone} to handle only absent keys (not `undefined` values)
 * @see {@link required} when absent input should fail instead of using a default
 *
 * @category constructors
 * @since 4.0.0
 */
export function withDefault<T, R = never>(
  defaultValue: Effect.Effect<T, Issue.Issue, R>
): Getter<T, T | undefined, R> {
  return new Getter((o) => {
    const filtered = Option.filter(o, Predicate.isNotUndefined)
    return Option.isSome(filtered) ? Effect.succeed(filtered) : Effect.mapEager(defaultValue, Option.some)
  })
}

/**
 * Coerces any value to a `string` using the global `String()` constructor.
 *
 * **When to use**
 *
 * Use when you need a string representation of an arbitrary encoded value.
 *
 * **Details**
 *
 * - Pure, never fails.
 * - Delegates to `globalThis.String`.
 *
 * **Example** (Coerce to string)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const toString = SchemaGetter.String<number>()
 * // Getter<string, number>
 * ```
 *
 * @see {@link transform} for custom string conversions
 *
 * @category Coercions
 * @since 4.0.0
 */
export function String<E>(): Getter<string, E> {
  return transform(globalThis.String)
}

/**
 * Coerces any value to a `number` using the global `Number()` constructor.
 *
 * **When to use**
 *
 * Use when you need numeric coercion of an encoded value.
 *
 * **Details**
 *
 * - Pure, never fails (may produce `NaN` for non-numeric inputs).
 * - Delegates to `globalThis.Number`.
 *
 * **Example** (Coerce to number)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const toNumber = SchemaGetter.Number<string>()
 * // Getter<number, string>
 * ```
 *
 * @see {@link transformOrFail} for validated number parsing
 *
 * @category Coercions
 * @since 4.0.0
 */
export function Number<E>(): Getter<number, E> {
  return transform(globalThis.Number)
}

/**
 * Coerces any value to a `boolean` using the global `Boolean()` constructor.
 *
 * **When to use**
 *
 * Use when you need boolean coercion (truthiness check) of an encoded value.
 *
 * **Details**
 *
 * - Pure, never fails.
 * - Delegates to `globalThis.Boolean`.
 *
 * **Example** (Coerce to boolean)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const toBool = SchemaGetter.Boolean<string>()
 * // Getter<boolean, string>
 * ```
 *
 * @category Coercions
 * @since 4.0.0
 */
export function Boolean<E>(): Getter<boolean, E> {
  return transform(globalThis.Boolean)
}

/**
 * Coerces a value to `bigint` using the global `BigInt()` constructor.
 *
 * **When to use**
 *
 * Use when you need to convert strings, numbers, or booleans to `bigint`.
 *
 * **Details**
 *
 * - Delegates to `globalThis.BigInt`.
 * - Throws at runtime if the input cannot be converted (e.g. non-numeric string).
 *
 * **Example** (Coerce to bigint)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const toBigInt = SchemaGetter.BigInt<string>()
 * // Getter<bigint, string>
 * ```
 *
 * @category Coercions
 * @since 4.0.0
 */
export function BigInt<E extends string | number | bigint | boolean>(): Getter<bigint, E> {
  return transform(globalThis.BigInt)
}

/**
 * Coerces a value to a `Date` using `new Date(input)`.
 *
 * **When to use**
 *
 * Use when you need to parse a string, number, or Date into a `Date` object.
 *
 * **Details**
 *
 * - Delegates to `new globalThis.Date(input)`.
 * - Does not validate the result — may produce an invalid Date.
 *
 * **Example** (Coerce to Date)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const toDate = SchemaGetter.Date<string>()
 * // Getter<Date, string>
 * ```
 *
 * @see {@link dateTimeUtcFromInput} for validated DateTime parsing
 *
 * @category Coercions
 * @since 4.0.0
 */
export function Date<E extends string | number | Date>(): Getter<Date, E> {
  return transform((u) => new globalThis.Date(u))
}

/**
 * Strips whitespace from both ends of a string.
 *
 * **Details**
 *
 * - Pure, delegates to `String.trim`.
 *
 * **Example** (Trim whitespace)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const trimmed = SchemaGetter.trim<string>()
 * ```
 *
 * @category string
 * @since 4.0.0
 */
export function trim<E extends string>(): Getter<string, E> {
  return transform(Str.trim)
}

/**
 * Capitalizes the first character of a string.
 *
 * **Details**
 *
 * - Pure, delegates to `String.capitalize`.
 *
 * **Example** (Capitalize string)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const cap = SchemaGetter.capitalize<string>()
 * ```
 *
 * @category string
 * @since 4.0.0
 */
export function capitalize<E extends string>(): Getter<string, E> {
  return transform(Str.capitalize)
}

/**
 * Uncapitalizes the first character of a string.
 *
 * **Details**
 *
 * - Pure, delegates to `String.uncapitalize`.
 *
 * **Example** (Uncapitalize string)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const uncap = SchemaGetter.uncapitalize<string>()
 * ```
 *
 * @category string
 * @since 4.0.0
 */
export function uncapitalize<E extends string>(): Getter<string, E> {
  return transform(Str.uncapitalize)
}

/**
 * Converts a `snake_case` string to `camelCase`.
 *
 * **Details**
 *
 * - Pure, delegates to `String.snakeToCamel`.
 *
 * **Example** (Snake to camel)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const toCamel = SchemaGetter.snakeToCamel<string>()
 * ```
 *
 * @see {@link camelToSnake} for the inverse operation
 *
 * @category string
 * @since 4.0.0
 */
export function snakeToCamel<E extends string>(): Getter<string, E> {
  return transform(Str.snakeToCamel)
}

/**
 * Converts a `camelCase` string to `snake_case`.
 *
 * **Details**
 *
 * - Pure, delegates to `String.camelToSnake`.
 *
 * **Example** (Camel to snake)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const toSnake = SchemaGetter.camelToSnake<string>()
 * ```
 *
 * @see {@link snakeToCamel} for the inverse operation
 *
 * @category string
 * @since 4.0.0
 */
export function camelToSnake<E extends string>(): Getter<string, E> {
  return transform(Str.camelToSnake)
}

/**
 * Converts a string to lowercase.
 *
 * **Details**
 *
 * - Pure, delegates to `String.toLowerCase`.
 *
 * **Example** (To lowercase)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const lower = SchemaGetter.toLowerCase<string>()
 * ```
 *
 * @see {@link toUpperCase} for the inverse operation
 *
 * @category string
 * @since 4.0.0
 */
export function toLowerCase<E extends string>(): Getter<string, E> {
  return transform(Str.toLowerCase)
}

/**
 * Converts a string to uppercase.
 *
 * **Details**
 *
 * - Pure, delegates to `String.toUpperCase`.
 *
 * **Example** (To uppercase)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const upper = SchemaGetter.toUpperCase<string>()
 * ```
 *
 * @see {@link toLowerCase} for the inverse operation
 *
 * @category string
 * @since 4.0.0
 */
export function toUpperCase<E extends string>(): Getter<string, E> {
  return transform(Str.toUpperCase)
}

type ParseJsonOptions = {
  readonly reviver?: Parameters<typeof JSON.parse>[1]
}

/**
 * Parses a JSON string into a value.
 *
 * **When to use**
 *
 * Use when an encoded value is a JSON string that needs to be parsed during decoding.
 *
 * **Details**
 *
 * - Skips `None` inputs.
 * - Without `reviver`: returns `Schema.MutableJson` (typed JSON).
 * - With `reviver`: returns `unknown` (reviver may produce arbitrary values).
 * - On parse failure, fails with `Issue.InvalidValue` containing the error message.
 *
 * **Example** (Parse JSON)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const parse = SchemaGetter.parseJson<string>()
 * // Getter<MutableJson, string>
 * ```
 *
 * @see {@link stringifyJson} for the inverse operation
 *
 * @category Json
 * @since 4.0.0
 */
export function parseJson<E extends string>(): Getter<Schema.MutableJson, E>
export function parseJson<E extends string>(options: ParseJsonOptions): Getter<unknown, E>
export function parseJson<E extends string>(options?: ParseJsonOptions | undefined): Getter<unknown, E> {
  return onSome((input) =>
    Effect.try({
      try: () => Option.some(JSON.parse(input, options?.reviver)),
      catch: (e) => new Issue.InvalidValue(Option.some(input), { message: globalThis.String(e) })
    })
  )
}

type StringifyJsonOptions = {
  readonly replacer?: Parameters<typeof JSON.stringify>[1]
  readonly space?: Parameters<typeof JSON.stringify>[2]
}

/**
 * Stringifies a present value using `JSON.stringify`.
 *
 * **When to use**
 *
 * Use when a decoded value needs to be serialized to JSON text during encoding.
 *
 * **Details**
 *
 * - Skips `None` inputs.
 * - On thrown stringify failures, such as circular references, fails with
 *   `Issue.InvalidValue`.
 * - Supports optional `replacer` and `space` options, matching
 *   `JSON.stringify`.
 * - If `JSON.stringify` returns `undefined`, such as for `undefined`,
 *   functions, symbols, or a replacer that removes the root value, that
 *   `undefined` result is returned rather than converted into an `Issue`.
 *
 * **Example** (Stringify JSON)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const stringify = SchemaGetter.stringifyJson()
 * // Getter<string, unknown>
 * ```
 *
 * @see {@link parseJson} for the inverse operation
 *
 * @category Json
 * @since 4.0.0
 */
export function stringifyJson(options?: StringifyJsonOptions): Getter<string, unknown> {
  return onSome((input) =>
    Effect.try({
      try: () => Option.some(JSON.stringify(input, options?.replacer, options?.space)),
      catch: (e) => new Issue.InvalidValue(Option.some(input), { message: globalThis.String(e) })
    })
  )
}

/**
 * Parses a string into a record of key-value pairs.
 *
 * **When to use**
 *
 * Use when an encoded string contains delimited key-value pairs (e.g. `"a=1,b=2"`).
 *
 * **Details**
 *
 * - Splits the string by `separator` (default `,`), then each pair by `keyValueSeparator` (default `=`).
 * - Pairs missing a key or value are silently skipped.
 * - Pure, never fails.
 *
 * **Example** (Parse key-value string)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const parse = SchemaGetter.splitKeyValue<string>()
 * // "a=1,b=2" -> { a: "1", b: "2" }
 * ```
 *
 * @see {@link joinKeyValue} for the inverse operation
 * @see {@link split} to split into an array of strings
 *
 * @category string
 * @since 4.0.0
 */
export function splitKeyValue<E extends string>(options?: {
  readonly separator?: string | undefined
  readonly keyValueSeparator?: string | undefined
}): Getter<Record<string, string>, E> {
  const separator = options?.separator ?? ","
  const keyValueSeparator = options?.keyValueSeparator ?? "="
  return transform((input) =>
    input.split(separator).reduce((acc, pair) => {
      const [key, value] = pair.split(keyValueSeparator)
      if (key && value) {
        acc[key] = value
      }
      return acc
    }, {} as Record<string, string>)
  )
}

/**
 * Joins a record of key-value pairs into a delimited string.
 *
 * **When to use**
 *
 * Use when a decoded record needs to be serialized as a delimited key-value string.
 *
 * **Details**
 *
 * - Joins entries with `separator` (default `,`) and key/value with `keyValueSeparator` (default `=`).
 * - Pure, never fails.
 *
 * **Example** (Join key-value record)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const join = SchemaGetter.joinKeyValue()
 * // { a: "1", b: "2" } -> "a=1,b=2"
 * ```
 *
 * @see {@link splitKeyValue} for the inverse operation
 *
 * @category string
 * @since 4.0.0
 */
export function joinKeyValue<E extends Record<PropertyKey, string>>(options?: {
  readonly separator?: string | undefined
  readonly keyValueSeparator?: string | undefined
}): Getter<string, E> {
  const separator = options?.separator ?? ","
  const keyValueSeparator = options?.keyValueSeparator ?? "="
  return transform((input) =>
    Object.entries(input).map(([key, value]) => `${key}${keyValueSeparator}${value}`).join(separator)
  )
}

/**
 * Splits a string into an array of strings by a separator.
 *
 * **When to use**
 *
 * Use when an encoded string is a delimited list (e.g. CSV values).
 *
 * **Details**
 *
 * - Splits by `separator` (default `,`).
 * - An empty string produces an empty array (not `[""]`).
 * - Pure, never fails.
 *
 * **Example** (Split comma-separated string)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const splitComma = SchemaGetter.split<string>()
 * // "a,b,c" -> ["a", "b", "c"]
 * // "" -> []
 * ```
 *
 * @see {@link splitKeyValue} when values are key-value pairs
 *
 * @category string
 * @since 4.0.0
 */
export function split<E extends string>(options?: {
  readonly separator?: string | undefined
}): Getter<ReadonlyArray<string>, E> {
  const separator = options?.separator ?? ","
  return transform((input) => input === "" ? [] : input.split(separator))
}

/**
 * Encodes a `Uint8Array` or string to a Base64 string.
 *
 * **Details**
 *
 * - Pure, never fails.
 *
 * **Example** (Encode to Base64)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const encode = SchemaGetter.encodeBase64<Uint8Array>()
 * ```
 *
 * @see {@link decodeBase64} for the inverse operation to `Uint8Array`
 * @see {@link decodeBase64String} for the inverse operation to `string`
 * @see {@link encodeBase64Url} for the URL-safe variant
 *
 * @category Base64
 * @since 4.0.0
 */
export function encodeBase64<E extends Uint8Array | string>(): Getter<string, E> {
  return transform(Encoding.encodeBase64)
}

/**
 * Encodes a `Uint8Array` or string to a URL-safe Base64 string.
 *
 * **Details**
 *
 * - Pure, never fails.
 *
 * **Example** (Encode to Base64Url)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const encode = SchemaGetter.encodeBase64Url<Uint8Array>()
 * ```
 *
 * @see {@link decodeBase64Url} for the inverse operation to `Uint8Array`
 * @see {@link decodeBase64UrlString} for the inverse operation to `string`
 * @see {@link encodeBase64} for the standard Base64 variant
 *
 * @category Base64
 * @since 4.0.0
 */
export function encodeBase64Url<E extends Uint8Array | string>(): Getter<string, E> {
  return transform(Encoding.encodeBase64Url)
}

/**
 * Encodes a `Uint8Array` or string to a hexadecimal string.
 *
 * **Details**
 *
 * - Pure, never fails.
 *
 * **Example** (Encode to hex)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const encode = SchemaGetter.encodeHex<Uint8Array>()
 * ```
 *
 * @see {@link decodeHex} for the inverse operation to `Uint8Array`
 * @see {@link decodeHexString} for the inverse operation to `string`
 *
 * @category Hex
 * @since 4.0.0
 */
export function encodeHex<E extends Uint8Array | string>(): Getter<string, E> {
  return transform(Encoding.encodeHex)
}

/**
 * Decodes a Base64 string to a `Uint8Array`.
 *
 * **Details**
 *
 * - Fails with `Issue.InvalidValue` if the input is not valid Base64.
 *
 * **Example** (Decode Base64 to bytes)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const decode = SchemaGetter.decodeBase64<string>()
 * // Getter<Uint8Array, string>
 * ```
 *
 * @see {@link decodeBase64String} to decode to `string` instead
 * @see {@link encodeBase64} for the inverse operation
 *
 * @category Base64
 * @since 4.0.0
 */
export function decodeBase64<E extends string>(): Getter<Uint8Array, E> {
  return transformOrFail((input) =>
    Effect.mapErrorEager(
      Effect.fromResult(Encoding.decodeBase64(input)),
      (e) => new Issue.InvalidValue(Option.some(input), { message: e.message })
    )
  )
}

/**
 * Decodes a Base64 string to a UTF-8 `string`.
 *
 * **Details**
 *
 * - Fails with `Issue.InvalidValue` if the input is not valid Base64.
 *
 * **Example** (Decode Base64 to string)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const decode = SchemaGetter.decodeBase64String<string>()
 * // Getter<string, string>
 * ```
 *
 * @see {@link decodeBase64} to decode to `Uint8Array` instead
 * @see {@link encodeBase64} for the inverse operation
 *
 * @category Base64
 * @since 4.0.0
 */
export function decodeBase64String<E extends string>(): Getter<string, E> {
  return transformOrFail((input) =>
    Result.match(Encoding.decodeBase64String(input), {
      onFailure: (e) => Effect.fail(new Issue.InvalidValue(Option.some(input), { message: e.message })),
      onSuccess: Effect.succeed
    })
  )
}

/**
 * Decodes a URL-safe Base64 string to a `Uint8Array`.
 *
 * **Details**
 *
 * - Fails with `Issue.InvalidValue` if the input is not valid Base64Url.
 *
 * **Example** (Decode Base64Url to bytes)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const decode = SchemaGetter.decodeBase64Url<string>()
 * // Getter<Uint8Array, string>
 * ```
 *
 * @see {@link decodeBase64UrlString} to decode to `string` instead
 * @see {@link encodeBase64Url} for the inverse operation
 *
 * @category Base64
 * @since 4.0.0
 */
export function decodeBase64Url<E extends string>(): Getter<Uint8Array, E> {
  return transformOrFail((input) =>
    Result.match(Encoding.decodeBase64Url(input), {
      onFailure: (e) => Effect.fail(new Issue.InvalidValue(Option.some(input), { message: e.message })),
      onSuccess: Effect.succeed
    })
  )
}

/**
 * Decodes a URL-safe Base64 string to a UTF-8 `string`.
 *
 * **Details**
 *
 * - Fails with `Issue.InvalidValue` if the input is not valid Base64Url.
 *
 * **Example** (Decode Base64Url to string)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const decode = SchemaGetter.decodeBase64UrlString<string>()
 * // Getter<string, string>
 * ```
 *
 * @see {@link decodeBase64Url} to decode to `Uint8Array` instead
 * @see {@link encodeBase64Url} for the inverse operation
 *
 * @category Base64
 * @since 4.0.0
 */
export function decodeBase64UrlString<E extends string>(): Getter<string, E> {
  return transformOrFail((input) =>
    Result.match(Encoding.decodeBase64UrlString(input), {
      onFailure: (e) => Effect.fail(new Issue.InvalidValue(Option.some(input), { message: e.message })),
      onSuccess: Effect.succeed
    })
  )
}

/**
 * Decodes a hexadecimal string to a `Uint8Array`.
 *
 * **Details**
 *
 * - Fails with `Issue.InvalidValue` if the input is not valid hex.
 *
 * **Example** (Decode hex to bytes)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const decode = SchemaGetter.decodeHex<string>()
 * // Getter<Uint8Array, string>
 * ```
 *
 * @see {@link decodeHexString} to decode to `string` instead
 * @see {@link encodeHex} for the inverse operation
 *
 * @category Hex
 * @since 4.0.0
 */
export function decodeHex<E extends string>(): Getter<Uint8Array, E> {
  return transformOrFail((input) =>
    Result.match(Encoding.decodeHex(input), {
      onFailure: (e) => Effect.fail(new Issue.InvalidValue(Option.some(input), { message: e.message })),
      onSuccess: Effect.succeed
    })
  )
}

/**
 * Decodes a hexadecimal string to a UTF-8 `string`.
 *
 * **Details**
 *
 * - Fails with `Issue.InvalidValue` if the input is not valid hex.
 *
 * **Example** (Decode hex to string)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const decode = SchemaGetter.decodeHexString<string>()
 * // Getter<string, string>
 * ```
 *
 * @see {@link decodeHex} to decode to `Uint8Array` instead
 * @see {@link encodeHex} for the inverse operation
 *
 * @category Hex
 * @since 4.0.0
 */
export function decodeHexString<E extends string>(): Getter<string, E> {
  return transformOrFail((input) =>
    Result.match(Encoding.decodeHexString(input), {
      onFailure: (e) => Effect.fail(new Issue.InvalidValue(Option.some(input), { message: e.message })),
      onSuccess: Effect.succeed
    })
  )
}

/**
 * Encodes a present string using `encodeURIComponent`.
 *
 * **Details**
 *
 * - Skips `None` inputs.
 * - May throw a `URIError` for malformed surrogate pairs; this exception is not
 *   converted into an `Issue`.
 *
 * **Example** (Encode a URI component)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const encode = SchemaGetter.encodeUriComponent<string>()
 * ```
 *
 * @see {@link decodeUriComponent} for the inverse operation
 *
 * @category URI
 * @since 4.0.0
 */
export function encodeUriComponent<E extends string>(): Getter<string, E> {
  return transform(encodeURIComponent)
}

/**
 * Decodes a URI component encoded string using `decodeURIComponent`.
 *
 * **Details**
 *
 * - Fails with `Issue.InvalidValue` if the input contains malformed percent-encoding sequences.
 *
 * **Example** (Decode a URI component)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const decode = SchemaGetter.decodeUriComponent<string>()
 * // Getter<string, string>
 * ```
 *
 * @see {@link encodeUriComponent} for the inverse operation
 *
 * @category URI
 * @since 4.0.0
 */
export function decodeUriComponent<E extends string>(): Getter<string, E> {
  return transformOrFail((input) => {
    try {
      return Effect.succeed(globalThis.decodeURIComponent(input))
    } catch (e) {
      return Effect.fail(
        new Issue.InvalidValue(Option.some(input), {
          message: e instanceof URIError ? e.message : "Invalid URI component"
        })
      )
    }
  })
}

/**
 * Parses a `DateTime.Input` value into a `DateTime.Utc`.
 *
 * **When to use**
 *
 * Use when an encoded value represents a date/time and should be decoded to a `DateTime.Utc`.
 *
 * **Details**
 *
 * - Accepted input includes existing `DateTime` values, partial date/time parts,
 *   instant objects, zoned instant objects, JavaScript `Date` instances, epoch
 *   milliseconds, and date strings.
 * - Converts successfully parsed values to UTC.
 * - Fails with `Issue.InvalidValue` if the input cannot be parsed as a valid
 *   `DateTime`.
 *
 * **Example** (Parse DateTime)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const parseDate = SchemaGetter.dateTimeUtcFromInput<string>()
 * // Getter<DateTime.Utc, string>
 * ```
 *
 * @see {@link Date} for a simpler coercion to `Date` (no validation)
 *
 * @category DateTime
 * @since 4.0.0
 */
export function dateTimeUtcFromInput<E extends DateTime.DateTime.Input>(): Getter<DateTime.Utc, E> {
  return transformOrFail((input) => {
    return Option.match(DateTime.make(input), {
      onNone: () => Effect.fail(new Issue.InvalidValue(Option.some(input), { message: "Invalid DateTime input" })),
      onSome: (dt) => Effect.succeed(DateTime.toUtc(dt))
    })
  })
}

/**
 * Decodes a `FormData` object into a nested tree structure using bracket-path notation.
 *
 * **When to use**
 *
 * Use to parse `FormData` from HTTP requests into structured objects.
 *
 * **Details**
 *
 * - Pure, never fails.
 * - Interprets bracket-path keys (e.g. `user[name]`, `items[0]`) to build nested objects/arrays.
 * - Leaf values are `string` or `Blob`.
 *
 * **Example** (Decode FormData)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const decode = SchemaGetter.decodeFormData()
 * // Getter<TreeObject<string | Blob>, FormData>
 * ```
 *
 * @see {@link encodeFormData} for the inverse operation
 * @see {@link makeTreeRecord} for the underlying bracket-path parser
 * @see {@link decodeURLSearchParams} for the URLSearchParams variant
 *
 * @category FormData
 * @since 4.0.0
 */
export function decodeFormData(): Getter<Schema.TreeRecord<string | Blob>, FormData> {
  return transform((input) => makeTreeRecord(Array.from(input.entries())))
}

const collectFormDataEntries = collectBracketPathEntries((value): value is string | Blob =>
  typeof value === "string" || (typeof Blob !== "undefined" && value instanceof Blob)
)

/**
 * Encodes a nested object into a `FormData` instance using bracket-path notation.
 *
 * **When to use**
 *
 * Use to serialize structured data to `FormData` for HTTP requests.
 *
 * **Details**
 *
 * - Pure, never fails.
 * - Flattens nested objects/arrays into bracket-path keys (e.g. `user[name]`, `items[0]`).
 * - Non-object inputs produce an empty `FormData`.
 *
 * **Example** (Encode to FormData)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const encode = SchemaGetter.encodeFormData()
 * // Getter<FormData, unknown>
 * ```
 *
 * @see {@link decodeFormData} for the inverse operation
 * @see {@link collectBracketPathEntries} for the underlying flattener
 * @see {@link encodeURLSearchParams} for the URLSearchParams variant
 *
 * @category FormData
 * @since 4.0.0
 */
export function encodeFormData(): Getter<FormData, unknown> {
  return transform((input) => {
    const out = new FormData()
    if (typeof input === "object" && input !== null) {
      const entries = collectFormDataEntries(input)
      entries.forEach(([key, value]) => {
        out.append(key, value)
      })
    }
    return out
  })
}

/**
 * Decodes a `URLSearchParams` object into a nested tree structure using bracket-path notation.
 *
 * **When to use**
 *
 * Use to parse query parameters from URLs into structured objects.
 *
 * **Details**
 *
 * - Pure, never fails.
 * - Interprets bracket-path keys (e.g. `user[name]`, `items[0]`) to build nested objects/arrays.
 * - Leaf values are `string`.
 *
 * **Example** (Decode URLSearchParams)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const decode = SchemaGetter.decodeURLSearchParams()
 * // Getter<TreeObject<string>, URLSearchParams>
 * ```
 *
 * @see {@link encodeURLSearchParams} for the inverse operation
 * @see {@link makeTreeRecord} for the underlying bracket-path parser
 * @see {@link decodeFormData} for the FormData variant
 *
 * @category URLSearchParams
 * @since 4.0.0
 */
export function decodeURLSearchParams(): Getter<Schema.TreeRecord<string>, URLSearchParams> {
  return transform((input) => makeTreeRecord(Array.from(input.entries())))
}

const collectURLSearchParamsEntries = collectBracketPathEntries(Predicate.isString)

/**
 * Encodes a nested object into a `URLSearchParams` instance using bracket-path notation.
 *
 * **When to use**
 *
 * Use to serialize structured data to query parameters for URLs.
 *
 * **Details**
 *
 * - Pure, never fails.
 * - Flattens nested objects/arrays into bracket-path keys.
 * - Non-object inputs produce an empty `URLSearchParams`.
 *
 * **Example** (Encode to URLSearchParams)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const encode = SchemaGetter.encodeURLSearchParams()
 * // Getter<URLSearchParams, unknown>
 * ```
 *
 * @see {@link decodeURLSearchParams} for the inverse operation
 * @see {@link collectBracketPathEntries} for the underlying flattener
 * @see {@link encodeFormData} for the FormData variant
 *
 * @category URLSearchParams
 * @since 4.0.0
 */
export function encodeURLSearchParams(): Getter<URLSearchParams, unknown> {
  return transform((input) => {
    if (typeof input === "object" && input !== null) {
      return new URLSearchParams(collectURLSearchParamsEntries(input))
    }
    return new URLSearchParams()
  })
}

const INDEX_REGEXP = /^\d+$/

function bracketPathToTokens(bracketPath: string): Array<string | number> {
  // real empty path (from append("", value))
  if (bracketPath === "") {
    return [""]
  }

  const replaced = bracketPath.replace(/\[(.*?)\]/g, ".$1")
  const parts = replaced.split(".")
  // if bracket path started with "[...]" we get ".foo" => ["", "foo"]; drop the synthetic first ""
  const start = replaced.startsWith(".") ? 1 : 0

  return parts
    .slice(start)
    .map((part) => (INDEX_REGEXP.test(part) ? globalThis.Number(part) : part))
}

/**
 * Builds a nested tree object from a list of bracket-path entries.
 *
 * **When to use**
 *
 * Use to parse FormData or URLSearchParams entries into structured objects.
 * - You have flat key-value pairs with bracket-path keys that need nesting.
 *
 * **Details**
 *
 * - A bracket path is a string like `"user[address][city]"` that describes nested
 *   object/array structure.
 * - Interprets bracket paths and constructs the corresponding nested object.
 * - Builds and returns a nested object from the input entries.
 * - Supported syntax:
 *   - `"foo"` → object key `"foo"`
 *   - `"foo[bar]"` → nested `{ foo: { bar: ... } }`
 *   - `"foo[0]"` → array index `{ foo: [value] }`
 *   - `"foo[]"` → append to array `foo`
 *   - `""` → real empty key
 * - Duplicate keys for the same path are merged into arrays.
 *
 * **Example** (Build tree from bracket paths)
 *
 * ```ts
 * import { SchemaGetter } from "effect"
 *
 * const tree = SchemaGetter.makeTreeRecord([
 *   ["user[name]", "Alice"],
 *   ["user[tags][]", "admin"],
 *   ["user[tags][]", "editor"]
 * ])
 * // { user: { name: "Alice", tags: ["admin", "editor"] } }
 * ```
 *
 * @see {@link collectBracketPathEntries} for the inverse operation (tree to flat entries)
 * @see {@link decodeFormData} for a higher-level FormData decoder
 * @see {@link decodeURLSearchParams} for a higher-level URLSearchParams decoder
 *
 * @category Tree
 * @since 4.0.0
 */
export function makeTreeRecord<A>(
  bracketPathEntries: ReadonlyArray<readonly [bracketPath: string, value: A]>
): Schema.TreeRecord<A> {
  const out: any = {}
  bracketPathEntries.forEach(([key, value]) => {
    const tokens = bracketPathToTokens(key)
    let cur: any = out
    tokens.forEach((token, i) => {
      const isLast = i === tokens.length - 1

      // We are inside an array and see "[]" (empty token) => append
      if (Array.isArray(cur) && token === "") {
        if (isLast) {
          cur.push(value)
        } else {
          // bracket path: "foo[][bar]" => push a new element and descend into it
          const next = tokens[i + 1]
          const shouldBeArray = typeof next === "number" || next === ""
          const index = cur.length

          if (cur[index] === undefined) {
            cur[index] = shouldBeArray ? [] : {}
          }

          cur = cur[index]
        }
      } else if (isLast) {
        // If we're setting a value at a path that already exists
        // convert it to an array to support multiple values for the same key
        if (Array.isArray(cur[token])) {
          cur[token].push(value)
        } else if (Object.prototype.hasOwnProperty.call(cur, token)) {
          cur[token] = [cur[token], value]
        } else {
          cur[token] = value
        }
      } else {
        const next = tokens[i + 1]
        // if next is a number OR "" (from []), we are building an array
        const shouldBeArray = typeof next === "number" || next === ""

        if (cur[token] === undefined) {
          cur[token] = shouldBeArray ? [] : {}
        }

        cur = cur[token]
      }
    })
  })
  return out
}

/**
 * Flattens a nested object into bracket-path entries, filtering leaf values by a type guard.
 *
 * **When to use**
 *
 * Use to serialize structured objects to flat key-value entries.
 * - Building custom `FormData` or `URLSearchParams` encoders.
 *
 * **Details**
 *
 * - This is the inverse of {@link makeTreeRecord}.
 * - Takes a nested object and produces flat `[bracketPath, value]` pairs suitable for
 *   `FormData` or `URLSearchParams`.
 * - Returns a curried function: first call provides the leaf type guard, second call provides the object.
 * - Recursively traverses objects and arrays.
 * - If all elements of an array are leaves, encodes them as multiple entries with the same key
 *   (e.g. `tags=a&tags=b`). Otherwise uses indexed bracket paths (e.g. `items[0]`, `items[1]`).
 * - Non-leaf values that aren't objects or arrays are silently skipped.
 *
 * **Example** (Flatten object to bracket paths)
 *
 * ```ts
 * import { Predicate, SchemaGetter } from "effect"
 *
 * const collectStrings = SchemaGetter.collectBracketPathEntries(Predicate.isString)
 * const entries = collectStrings({ user: { name: "Alice", tags: ["admin", "editor"] } })
 * // [["user[name]", "Alice"], ["user[tags]", "admin"], ["user[tags]", "editor"]]
 * ```
 *
 * @see {@link makeTreeRecord} for the inverse operation (flat entries to tree)
 * @see {@link encodeFormData} for a higher-level FormData encoder
 * @see {@link encodeURLSearchParams} for a higher-level URLSearchParams encoder
 *
 * @category Tree
 * @since 4.0.0
 */
export function collectBracketPathEntries<A>(isLeaf: (value: unknown) => value is A) {
  return (input: object): Array<[bracketPath: string, value: A]> => {
    const bracketPathEntries: Array<[string, A]> = []

    function append(key: string, value: unknown): void {
      if (isLeaf(value)) {
        bracketPathEntries.push([key, value])
      } else if (Array.isArray(value)) {
        // If all values are leaves, encode as multiple entries with the same key
        const allLeaves = value.every(isLeaf)
        if (allLeaves) {
          value.forEach((v) => {
            bracketPathEntries.push([key, v])
          })
        } else {
          value.forEach((v, i) => {
            append(`${key}[${i}]`, v)
          })
        }
      } else if (typeof value === "object" && value !== null) {
        for (const [k, v] of Object.entries(value)) {
          append(`${key}[${k}]`, v)
        }
      }
    }

    for (const [key, value] of Object.entries(input)) {
      append(key, value)
    }

    return bracketPathEntries
  }
}
