/**
 * Build reusable runtime parsers from Effect schemas.
 *
 * `SchemaParser` is the execution layer behind schema ASTs. It walks schema
 * structure, applies transformations, merges parse options, runs checks, and
 * reports failures as `SchemaIssue.Issue` values while exposing adapters for
 * the result shape a boundary needs.
 *
 * **Mental model**
 *
 * - A schema has a decoded `Type` side and an `Encoded` side.
 * - Decoders read `Encoded` or `unknown` input and produce `Type`.
 * - Encoders read `Type` or `unknown` input and produce `Encoded`.
 * - Maker helpers construct decoded `Type` values and apply constructor
 *   defaults before validation.
 * - The same underlying parser can be adapted to `Effect`, `Promise`, `Exit`,
 *   `Result`, `Option`, a throwing synchronous function, or a type guard.
 *
 * **Common tasks**
 *
 * - Construct decoded values: {@link make}, {@link makeEffect},
 *   {@link makeOption}
 * - Decode untrusted boundary input: {@link decodeUnknownEffect},
 *   {@link decodeUnknownSync}, {@link decodeUnknownResult}
 * - Decode already typed encoded input: {@link decodeEffect},
 *   {@link decodeSync}
 * - Encode values back to their encoded representation:
 *   {@link encodeEffect}, {@link encodeSync}, {@link encodeUnknownEffect}
 * - Check values without collecting issue details: {@link is}, {@link asserts}
 * - Build directly from an AST: {@link run}
 *
 * **Gotchas**
 *
 * - `decodeUnknown*` accepts untyped input; `decode*` variants expect the
 *   schema's `Encoded` type.
 * - `encodeUnknown*` accepts untyped input; `encode*` variants expect the
 *   schema's decoded `Type`.
 * - Synchronous adapters cannot run asynchronous parsing work. Use `Effect`
 *   adapters when transformations require services or asynchronous effects.
 * - Parse options supplied when a parser is created are merged with options
 *   supplied at call time, and schema-level parse annotations can further
 *   refine behavior.
 *
 * @since 4.0.0
 */
import * as Arr from "./Array.ts"
import * as Cause from "./Cause.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import { identity, memoize } from "./Function.ts"
import * as InternalAnnotations from "./internal/schema/annotations.ts"
import * as Option from "./Option.ts"
import * as Predicate from "./Predicate.ts"
import * as Result from "./Result.ts"
import type * as Schema from "./Schema.ts"
import * as AST from "./SchemaAST.ts"
import * as Issue from "./SchemaIssue.ts"

const recurDefaults = memoize((ast: AST.AST): AST.AST => {
  switch (ast._tag) {
    case "Declaration": {
      const getLink = ast.annotations?.[AST.ClassTypeId]
      if (Predicate.isFunction(getLink)) {
        const link = getLink(ast.typeParameters)
        const to = recurDefaults(link.to)
        return AST.replaceEncoding(ast, to === link.to ? [link] : [new AST.Link(to, link.transformation)])
      }
      return ast
    }
    case "Objects":
    case "Arrays":
      return ast.recur((ast) => {
        const defaultValue = ast.context?.defaultValue
        if (defaultValue) {
          return AST.replaceEncoding(recurDefaults(ast), defaultValue)
        }
        return recurDefaults(ast)
      })
    case "Suspend":
      return ast.recur(recurDefaults)
    default:
      return ast
  }
})

/**
 * Creates an effectful maker for the schema's decoded type side.
 *
 * **When to use**
 *
 * Use to construct decoded schema values in `Effect` while preserving
 * construction issues in the error channel.
 *
 * **Details**
 *
 * The returned function accepts constructor input, applies constructor defaults,
 * runs type-side validation unless checks are disabled, and fails with a
 * `SchemaIssue.Issue` when construction fails.
 *
 * @category Constructing
 * @since 4.0.0
 */
export function makeEffect<S extends Schema.Top>(schema: S) {
  const ast = recurDefaults(AST.toType(schema.ast))
  const parser = run<S["Type"], never>(ast)
  return (input: S["~type.make.in"], options?: Schema.MakeOptions): Effect.Effect<S["Type"], Issue.Issue> => {
    return parser(
      input,
      options?.disableChecks
        ? options?.parseOptions ? { ...options.parseOptions, disableChecks: true } : { disableChecks: true }
        : options?.parseOptions
    )
  }
}

/**
 * Creates a synchronous maker that returns `Option.some` with the constructed
 * value on success, or `Option.none` when construction fails.
 *
 * **When to use**
 *
 * Use when you only need to know whether constructor input is valid and do
 * not need error details.
 *
 * @category Constructing
 * @since 4.0.0
 */
export function makeOption<S extends Schema.Top>(schema: S) {
  const parser = makeEffect(schema)
  return (input: S["~type.make.in"], options?: Schema.MakeOptions): Option.Option<S["Type"]> => {
    return Exit.getSuccess(Effect.runSyncExit(parser(input, options) as any))
  }
}

/**
 * Creates a synchronous maker for the schema's decoded type side.
 *
 * **When to use**
 *
 * Use to construct decoded schema values synchronously when invalid input
 * should throw.
 *
 * **Details**
 *
 * The returned function constructs a value from constructor input and throws an
 * `Error` with the `SchemaIssue.Issue` in its `cause` when construction fails.
 *
 * @category Constructing
 * @since 4.0.0
 */
export function make<S extends Schema.Top>(schema: S) {
  const parser = makeEffect(schema)
  return (input: S["~type.make.in"], options?: Schema.MakeOptions): S["Type"] => {
    return Effect.runSync(
      Effect.mapErrorEager(
        parser(input, options),
        (issue) => new Error(issue.toString(), { cause: issue })
      )
    )
  }
}

/**
 * Creates a type guard that checks whether an input satisfies the schema's decoded
 * type side.
 *
 * **When to use**
 *
 * Use to build a type guard for checking the decoded side of a schema without
 * exposing issue details.
 *
 * **Details**
 *
 * The guard returns `true` on successful validation and `false` on failure, without
 * exposing issue details.
 *
 * @category Asserting
 * @since 3.10.0
 */
export function is<T>(schema: Schema.Schema<T>): <I>(input: I) => input is I & T {
  return _is<T>(schema.ast)
}

/** @internal */
export function _is<T>(ast: AST.AST) {
  const parser = asExit(run<T, never>(AST.toType(ast)))
  return <I>(input: I): input is I & T => {
    return Exit.isSuccess(parser(input, AST.defaultParseOptions))
  }
}

/** @internal */
export function _issue<T>(ast: AST.AST) {
  const parser = run<T, never>(ast)
  return (input: unknown, options: AST.ParseOptions): Issue.Issue | undefined => {
    return Effect.runSync(Effect.matchEager(parser(input, options), {
      onSuccess: () => undefined,
      onFailure: identity
    }))
  }
}

/**
 * Asserts that an input satisfies the schema's decoded type side.
 *
 * **When to use**
 *
 * Use to assert that an input satisfies the decoded side of a schema, throwing
 * when validation fails.
 *
 * **Details**
 *
 * The assertion returns normally when validation succeeds and throws when the
 * input does not satisfy the schema.
 *
 * @category Asserting
 * @since 4.0.0
 */
export function asserts<S extends Schema.Top, I>(schema: S, input: I): asserts input is I & S["Type"] {
  const parser = asExit(run<S["Type"], never>(AST.toType(schema.ast)))
  const exit = parser(input, AST.defaultParseOptions)
  if (Exit.isFailure(exit)) {
    const issue = Cause.findError(exit.cause)
    if (Result.isFailure(issue)) {
      throw Cause.squash(issue.failure)
    }
    throw new Error(issue.success.toString(), { cause: issue.success })
  }
}

/**
 * Creates an effectful decoder for `unknown` input.
 *
 * **When to use**
 *
 * Use when decoding untyped boundary input while preserving decoding failures,
 * effectful transformations, and service requirements in an `Effect`.
 *
 * **Details**
 *
 * The returned function succeeds with the schema's decoded `Type` or fails with a
 * `SchemaIssue.Issue`. Decoding service requirements are preserved in the returned
 * `Effect`. Parse options may be provided when creating the decoder and overridden
 * when applying it.
 *
 * @see {@link decodeEffect} for input already typed as the schema's `Encoded` type
 *
 * @category decoding
 * @since 4.0.0
 */
export function decodeUnknownEffect<S extends Schema.Top>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Effect.Effect<S["Type"], Issue.Issue, S["DecodingServices"]> {
  const parser = run<S["Type"], S["DecodingServices"]>(schema.ast)
  return options === undefined
    ? parser
    : (input, overrideOptions) => parser(input, mergeParseOptions(options, overrideOptions))
}

/**
 * Creates an effectful decoder for input already typed as the schema's `Encoded`
 * type.
 *
 * **When to use**
 *
 * Use when the input is already typed as the schema's `Encoded` type and
 * decoding should stay in `Effect`, including parse failures and required
 * decoding services.
 *
 * **Details**
 *
 * The returned function succeeds with the decoded `Type` or fails with a
 * `SchemaIssue.Issue`, preserving any decoding service requirements in the
 * returned `Effect`.
 *
 * @see {@link decodeUnknownEffect} for untyped boundary input
 * @see {@link encodeEffect} for the opposite direction
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeEffect: <S extends Schema.Top>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => Effect.Effect<S["Type"], Issue.Issue, S["DecodingServices"]> =
  decodeUnknownEffect

/**
 * Creates a Promise-based decoder for `unknown` input.
 *
 * **When to use**
 *
 * Use when decoding untyped input with a service-free schema at a JavaScript
 * `Promise` boundary.
 *
 * **Details**
 *
 * The returned function resolves with the decoded `Type` on success and rejects
 * with a `SchemaIssue.Issue` on decoding failure.
 *
 * @see {@link decodePromise} for input already typed as the schema's `Encoded` type
 * @see {@link decodeUnknownEffect} for schemas that require decoding services or when failures should remain in `Effect`
 *
 * @category decoding
 * @since 3.10.0
 */
export function decodeUnknownPromise<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Promise<S["Type"]> {
  return asPromise(decodeUnknownEffect(schema, options))
}

/**
 * Creates a Promise-based decoder for input already typed as the schema's
 * `Encoded` type.
 *
 * **When to use**
 *
 * Use when the input is already typed as the schema's `Encoded` type and you
 * need a native `Promise` boundary.
 *
 * **Details**
 *
 * The returned function resolves with the decoded `Type` on success and rejects
 * with a `SchemaIssue.Issue` on decoding failure.
 *
 * @see {@link decodeUnknownPromise} for untyped input at a `Promise` boundary
 * @see {@link decodeEffect} for preserving decoding services and failures in `Effect`
 *
 * @category decoding
 * @since 3.10.0
 */
export function decodePromise<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: S["Encoded"], options?: AST.ParseOptions) => Promise<S["Type"]> {
  return asPromise(decodeEffect(schema, options))
}

/**
 * Creates a synchronous decoder for `unknown` input that reports failure safely
 * as an `Exit`.
 *
 * **When to use**
 *
 * Use when decoding unknown input synchronously and preserving the parser
 * outcome as an `Exit` value.
 *
 * **Details**
 *
 * The returned function produces `Exit.Success` with the decoded `Type`.
 * Schema issues are represented by an `Exit.Failure` cause containing a
 * `SchemaIssue.Issue`.
 *
 * **Gotchas**
 *
 * Because this adapter runs synchronously, async decoding work can produce an
 * `Exit.Failure` with a defect cause.
 *
 * @see {@link decodeExit} for input already typed as the schema's `Encoded` type
 * @see {@link decodeUnknownEffect} for preserving decoding services and failures in `Effect`
 * @see {@link decodeUnknownOption} for discarding issue details
 * @see {@link decodeUnknownResult} for returning schema issues as data
 * @see {@link decodeUnknownSync} for throwing on decoding failure
 *
 * @category decoding
 * @since 4.0.0
 */
export function decodeUnknownExit<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Exit.Exit<S["Type"], Issue.Issue> {
  return asExit(decodeUnknownEffect(schema, options))
}

/**
 * Creates a synchronous decoder for input already typed as the schema's `Encoded`
 * type, reporting failure safely as an `Exit`.
 *
 * **When to use**
 *
 * Use to synchronously decode already typed `Encoded` input when you want
 * decoding failures returned as `Exit` values.
 *
 * **Details**
 *
 * The returned function produces `Exit.Success` with the decoded `Type` or
 * `Exit.Failure` with a `SchemaIssue.Issue`.
 *
 * @see {@link decodeUnknownExit} for untyped input with the same `Exit` result shape
 * @see {@link decodeEffect} for preserving decoding services and failures in `Effect`
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeExit: <S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => Exit.Exit<S["Type"], Issue.Issue> = decodeUnknownExit

/**
 * Creates a decoder for `unknown` input that returns an `Option` safely.
 *
 * **When to use**
 *
 * Use when you need a synchronous yes/no decode from untyped input and do not
 * need schema issue details.
 *
 * **Details**
 *
 * The returned function produces `Option.some` with the decoded `Type` on success
 * or `Option.none` on failure, discarding issue details.
 *
 * @see {@link decodeOption} for input already typed as the schema's `Encoded` type
 * @see {@link decodeUnknownResult} for retaining schema issues as data
 *
 * @category decoding
 * @since 3.10.0
 */
export function decodeUnknownOption<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Option.Option<S["Type"]> {
  return asOption(decodeUnknownEffect(schema, options))
}

/**
 * Creates a decoder safely for input already typed as the schema's `Encoded` type,
 * returning an `Option`.
 *
 * **When to use**
 *
 * Use when the input is already typed as the schema's `Encoded` type and you
 * only need to know whether decoding succeeds.
 *
 * **Details**
 *
 * The returned function produces `Option.some` with the decoded `Type` on success
 * or `Option.none` on failure, discarding issue details.
 *
 * @see {@link decodeUnknownOption} for untyped input with the same yes/no result shape
 * @see {@link decodeResult} for retaining schema issues as data
 *
 * @category decoding
 * @since 3.10.0
 */
export const decodeOption: <S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => Option.Option<S["Type"]> = decodeUnknownOption

/**
 * Creates a decoder for `unknown` input that reports failure safely as a
 * `Result`.
 *
 * **When to use**
 *
 * Use when decoding untyped boundary input and you want schema issues returned
 * as data in a `Result`.
 *
 * **Details**
 *
 * The returned function produces `Result.succeed` with the decoded `Type` on
 * success or `Result.fail` with a `SchemaIssue.Issue` on decoding failure.
 *
 * **Gotchas**
 *
 * This adapter runs synchronously. Schema issues become `Result.fail`, but async
 * decoding or defects can still throw.
 *
 * @see {@link decodeResult} for input already typed as the schema's `Encoded` type
 * @see {@link decodeUnknownEffect} for effectful or service-requiring decoding
 *
 * @category decoding
 * @since 4.0.0
 */
export function decodeUnknownResult<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Result.Result<S["Type"], Issue.Issue> {
  return asResult(decodeUnknownEffect(schema, options))
}

/**
 * Creates a decoder for input already typed as the schema's `Encoded` type,
 * reporting failure safely as a `Result`.
 *
 * **When to use**
 *
 * Use when the input is already typed as the schema's `Encoded` type and you
 * want schema decoding failures represented as `Result.fail`.
 *
 * **Details**
 *
 * The returned function produces `Result.succeed` with the decoded `Type` on
 * success or `Result.fail` with a `SchemaIssue.Issue` on decoding failure.
 *
 * **Gotchas**
 *
 * This synchronous adapter returns `Result.fail` for schema issues, but async
 * decoding or other non-schema failures can still throw.
 *
 * @see {@link decodeUnknownResult} for untyped input with the same `Result` shape
 * @see {@link decodeEffect} for effectful or service-requiring decoding
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeResult: <S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => Result.Result<S["Type"], Issue.Issue> = decodeUnknownResult

/**
 * Creates a synchronous decoder for `unknown` input.
 *
 * **When to use**
 *
 * Use to decode untrusted or dynamically typed input at a synchronous boundary
 * where invalid data should be reported by throwing.
 *
 * **Details**
 *
 * The returned function returns the decoded `Type` on success and throws an
 * `Error` with the `SchemaIssue.Issue` in its `cause` on decoding failure.
 *
 * @see {@link decodeSync} for input already typed as the schema's `Encoded` type
 * @see {@link decodeUnknownEffect} for preserving decoding failures in `Effect`
 * @see {@link decodeUnknownResult} for returning schema issues as data
 *
 * @category decoding
 * @since 3.10.0
 */
export function decodeUnknownSync<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => S["Type"] {
  return asSync(decodeUnknownEffect(schema, options))
}

/**
 * Creates a synchronous decoder for input already typed as the schema's `Encoded`
 * type.
 *
 * **When to use**
 *
 * Use to decode values already typed as the schema's `Encoded` input when
 * decoding failure should be reported by throwing an `Error`.
 *
 * **Details**
 *
 * The returned function returns the decoded `Type` on success and throws an
 * `Error` with the `SchemaIssue.Issue` in its `cause` on decoding failure.
 *
 * @see {@link decodeUnknownSync} for untrusted or dynamically typed input
 * @see {@link decodeResult} for returning schema issues as data
 * @see {@link decodeEffect} for preserving decoding failures in `Effect`
 *
 * @category decoding
 * @since 3.10.0
 */
export const decodeSync: <S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => S["Type"] = decodeUnknownSync

/**
 * Creates an effectful encoder for `unknown` input.
 *
 * **When to use**
 *
 * Use when encoding untyped boundary input and preserving encoding failures and
 * service requirements in `Effect` is the desired result shape.
 *
 * **Details**
 *
 * The returned function succeeds with the schema's `Encoded` value or fails with a
 * `SchemaIssue.Issue`. Encoding service requirements are preserved in the returned
 * `Effect`. Parse options may be provided when creating the encoder and overridden
 * when applying it.
 *
 * @see {@link encodeEffect} for the typed-input variant when the value is already typed as the schema's decoded `Type`
 *
 * @category encoding
 * @since 4.0.0
 */
export function encodeUnknownEffect<S extends Schema.Top>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Effect.Effect<S["Encoded"], Issue.Issue, S["EncodingServices"]> {
  const parser = run<S["Encoded"], S["EncodingServices"]>(AST.flip(schema.ast))
  return options === undefined
    ? parser
    : (input, overrideOptions) => parser(input, mergeParseOptions(options, overrideOptions))
}

/**
 * Creates an effectful encoder for input already typed as the schema's decoded
 * `Type`.
 *
 * **When to use**
 *
 * Use to encode values already typed as the schema's decoded `Type` when
 * encoding should preserve service requirements and return failures in an
 * `Effect`.
 *
 * **Details**
 *
 * The returned function succeeds with the schema's `Encoded` value or fails with a
 * `SchemaIssue.Issue`, preserving any encoding service requirements in the
 * returned `Effect`.
 *
 * @see {@link encodeUnknownEffect} for encoding unknown input before the value is statically typed as the schema's `Type`
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeEffect: <S extends Schema.Top>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Effect.Effect<S["Encoded"], Issue.Issue, S["EncodingServices"]> =
  encodeUnknownEffect

/**
 * Creates a Promise-based encoder for `unknown` input.
 *
 * **When to use**
 *
 * Use to encode untrusted or dynamically typed values at a `Promise` boundary
 * when the schema has no encoding service requirements.
 *
 * **Details**
 *
 * The returned function resolves with the schema's `Encoded` value on success and
 * rejects with a `SchemaIssue.Issue` on encoding failure.
 *
 * @see {@link encodePromise} for input already typed as the schema's decoded `Type`
 * @see {@link encodeUnknownEffect} for schemas that require encoding services or when failures should remain in `Effect`
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodeUnknownPromise = <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Promise<S["Encoded"]> =>
  asPromise(encodeUnknownEffect(schema, options))

/**
 * Creates a Promise-based encoder for input already typed as the schema's decoded
 * `Type`.
 *
 * **When to use**
 *
 * Use when you need a `Promise`-returning encoder for values already typed as
 * the schema's decoded `Type`, such as at a JavaScript `Promise` interop
 * boundary.
 *
 * **Details**
 *
 * The returned function resolves with the schema's `Encoded` value on success and
 * rejects with a `SchemaIssue.Issue` on encoding failure.
 *
 * @see {@link encodeUnknownPromise} for encoding untyped input
 * @see {@link encodeEffect} for effectful encoding or schemas with encoding service requirements
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodePromise: <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Promise<S["Encoded"]> = encodeUnknownPromise

/**
 * Creates a synchronous encoder for `unknown` input that reports failure safely
 * as an `Exit`.
 *
 * **When to use**
 *
 * Use to encode unknown input synchronously when you want the encoded value or
 * schema issue represented as an `Exit`.
 *
 * **Details**
 *
 * The returned function produces `Exit.Success` with the schema's `Encoded` value
 * or `Exit.Failure` with a `SchemaIssue.Issue`.
 *
 * @see {@link encodeExit} for input already typed as the schema's decoded `Type`
 * @see {@link encodeUnknownEffect} for effectful encoding that preserves service requirements
 *
 * @category encoding
 * @since 4.0.0
 */
export function encodeUnknownExit<S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Exit.Exit<S["Encoded"], Issue.Issue> {
  return asExit(encodeUnknownEffect(schema, options))
}

/**
 * Creates a synchronous encoder for input already typed as the schema's decoded
 * `Type`, reporting failure safely as an `Exit`.
 *
 * **When to use**
 *
 * Use to synchronously encode already typed schema values when you want encoding
 * failures returned as `Exit` values.
 *
 * **Details**
 *
 * The returned function produces `Exit.Success` with the schema's `Encoded` value
 * or `Exit.Failure` with a `SchemaIssue.Issue`.
 *
 * @see {@link encodeUnknownExit} for unknown input with the same `Exit` result shape
 * @see {@link encodeEffect} for effectful encoding that preserves service requirements
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeExit: <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Exit.Exit<S["Encoded"], Issue.Issue> = encodeUnknownExit

/**
 * Creates an encoder for `unknown` input that returns an `Option` safely.
 *
 * **When to use**
 *
 * Use when encoding untyped input and you want a synchronous `Option` result
 * that keeps the encoded value on success but discards issue details on failure.
 *
 * **Details**
 *
 * The returned function produces `Option.some` with the schema's `Encoded` value
 * on success or `Option.none` on failure, discarding issue details.
 *
 * @see {@link encodeOption} for input already typed as the schema's decoded `Type`
 * @see {@link encodeUnknownResult} for retaining schema issues as data
 *
 * @category encoding
 * @since 3.10.0
 */
export function encodeUnknownOption<S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Option.Option<S["Encoded"]> {
  return asOption(encodeUnknownEffect(schema, options))
}

/**
 * Creates an encoder safely for input already typed as the schema's decoded `Type`,
 * returning an `Option`.
 *
 * **When to use**
 *
 * Use when encoding values that are already typed as the schema's decoded
 * `Type` and an `Option` result is the desired success/failure boundary.
 *
 * **Details**
 *
 * The returned function produces `Option.some` with the schema's `Encoded` value
 * on success or `Option.none` on failure, discarding issue details.
 *
 * @see {@link encodeUnknownOption} for untyped input with the same yes/no result shape
 * @see {@link encodeResult} for retaining schema issues as data
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodeOption: <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Option.Option<S["Encoded"]> = encodeUnknownOption

/**
 * Creates an encoder for `unknown` input that reports failure safely as a
 * `Result`.
 *
 * **When to use**
 *
 * Use when encoding values from an unknown or dynamically typed boundary
 * synchronously, and you want schema issues returned as `Result` data.
 *
 * **Details**
 *
 * The returned function produces `Result.succeed` with the schema's `Encoded`
 * value on success or `Result.fail` with a `SchemaIssue.Issue` on encoding
 * failure.
 *
 * @see {@link encodeResult} for input already typed as the schema's decoded `Type`
 * @see {@link encodeUnknownEffect} for effectful encoding, including schemas with encoding service requirements
 *
 * @category encoding
 * @since 4.0.0
 */
export function encodeUnknownResult<S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Result.Result<S["Encoded"], Issue.Issue> {
  return asResult(encodeUnknownEffect(schema, options))
}

/**
 * Creates an encoder for input already typed as the schema's decoded `Type`,
 * reporting failure safely as a `Result`.
 *
 * **When to use**
 *
 * Use when the input is already typed as the schema's decoded `Type` and
 * encoding failures should be returned as a `Result` instead of thrown or run in
 * `Effect`.
 *
 * **Details**
 *
 * The returned function produces `Result.succeed` with the schema's `Encoded`
 * value on success or `Result.fail` with a `SchemaIssue.Issue` on encoding
 * failure.
 *
 * @see {@link encodeUnknownResult} for the same `Result` shape when the input is not already typed
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeResult: <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Result.Result<S["Encoded"], Issue.Issue> = encodeUnknownResult

/**
 * Creates a synchronous encoder for `unknown` input.
 *
 * **When to use**
 *
 * Use when encoding values from untyped input in synchronous code and treating
 * encoding failures as thrown errors is the desired boundary.
 *
 * **Details**
 *
 * The returned function returns the schema's `Encoded` value on success and throws
 * an `Error` with the `SchemaIssue.Issue` in its `cause` on encoding failure.
 *
 * @see {@link encodeSync} for input already typed as the schema's decoded `Type`
 * @see {@link encodeUnknownEffect} for effectful encoding that preserves service requirements
 *
 * @category encoding
 * @since 3.10.0
 */
export function encodeUnknownSync<S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => S["Encoded"] {
  return asSync(encodeUnknownEffect(schema, options))
}

/**
 * Creates a synchronous encoder for input already typed as the schema's decoded
 * `Type`.
 *
 * **When to use**
 *
 * Use to encode already typed schema values synchronously when encoding failure
 * should be reported by throwing an `Error`.
 *
 * **Details**
 *
 * The returned function returns the schema's `Encoded` value on success and throws
 * an `Error` with the `SchemaIssue.Issue` in its `cause` on encoding failure.
 *
 * @see {@link encodeUnknownSync} for unknown input with the same throwing boundary
 * @see {@link encodeOption} for discarding failure details
 * @see {@link encodeResult} for returning schema issues as data
 * @see {@link encodeEffect} for effectful encoding that preserves service requirements
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodeSync: <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => S["Encoded"] = encodeUnknownSync

const mergeParseOptions = (
  options: AST.ParseOptions,
  overrideOptions: AST.ParseOptions | undefined
): AST.ParseOptions => overrideOptions === undefined ? options : { ...options, ...overrideOptions }

/** @internal */
export function run<T, R>(ast: AST.AST) {
  const parser = recur(ast)
  return (input: unknown, options?: AST.ParseOptions): Effect.Effect<T, Issue.Issue, R> =>
    Effect.flatMapEager(parser(Option.some(input), options ?? AST.defaultParseOptions), (oa) => {
      if (oa._tag === "None") {
        return Effect.fail(new Issue.InvalidValue(oa))
      }
      return Effect.succeed(oa.value as T)
    })
}

function asPromise<T, E>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue>
): (input: E, options?: AST.ParseOptions) => Promise<T> {
  return (input: E, options?: AST.ParseOptions) => Effect.runPromise(parser(input, options))
}

function asExit<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => Exit.Exit<T, Issue.Issue> {
  return (input: E, options?: AST.ParseOptions) => Effect.runSyncExit(parser(input, options) as any)
}

/** @internal */
export function asOption<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => Option.Option<T> {
  const parserExit = asExit(parser)
  return (input: E, options?: AST.ParseOptions) => Exit.getSuccess(parserExit(input, options))
}

function asResult<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => Result.Result<T, Issue.Issue> {
  const parserExit = asExit(parser)
  return (input: E, options?: AST.ParseOptions) => {
    const exit = parserExit(input, options)
    if (Exit.isSuccess(exit)) {
      return Result.succeed(exit.value)
    }
    const error = Cause.findError(exit.cause)
    if (Result.isFailure(error)) {
      throw Cause.squash(error.failure)
    }
    return Result.fail(error.success)
  }
}

function asSync<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => T {
  return (input: E, options?: AST.ParseOptions) =>
    Effect.runSync(
      Effect.mapErrorEager(
        parser(input, options),
        (issue) => new Error(issue.toString(), { cause: issue })
      ) as any
    )
}

/** @internal */
export interface Parser {
  (input: Option.Option<unknown>, options: AST.ParseOptions): Effect.Effect<Option.Option<unknown>, Issue.Issue, any>
}

const recur = memoize(
  (ast: AST.AST): Parser => {
    let parser: Parser
    const astOptions = InternalAnnotations.resolve(ast)?.["parseOptions"]
    if (!ast.context && !ast.encoding && !ast.checks) {
      return (ou, options) => {
        parser ??= ast.getParser(recur)
        if (astOptions) {
          options = { ...options, ...astOptions }
        }
        return parser(ou, options)
      }
    }
    const isStructural = AST.isArrays(ast) || AST.isObjects(ast) ||
      (AST.isDeclaration(ast) && ast.typeParameters.length > 0)
    return (ou, options) => {
      if (astOptions) {
        options = { ...options, ...astOptions }
      }
      const encoding = ast.encoding
      let srou: Effect.Effect<Option.Option<unknown>, Issue.Issue, unknown> | undefined
      if (encoding) {
        const links = encoding
        const len = links.length
        for (let i = len - 1; i >= 0; i--) {
          const link = links[i]
          const to = link.to
          const parser = recur(to)
          srou = srou ? Effect.flatMapEager(srou, (ou) => parser(ou, options)) : parser(ou, options)
          if (link.transformation._tag === "Transformation") {
            const getter = link.transformation.decode
            srou = Effect.flatMapEager(srou, (ou) => getter.run(ou, options))
          } else {
            srou = link.transformation.decode(srou, options)
          }
        }
        srou = Effect.mapErrorEager(srou!, (issue) => new Issue.Encoding(ast, ou, issue))
      }

      parser ??= ast.getParser(recur)
      let sroa = srou ? Effect.flatMapEager(srou, (ou) => parser(ou, options)) : parser(ou, options)

      if (ast.checks && !options?.disableChecks) {
        const checks = ast.checks
        if (options?.errors === "all" && isStructural && Option.isSome(ou)) {
          sroa = Effect.catchEager(sroa, (issue) => {
            const issues: Array<Issue.Issue> = []
            AST.collectIssues(
              checks.filter((check) => check.annotations?.[AST.STRUCTURAL_ANNOTATION_KEY]),
              ou.value,
              issues,
              ast,
              options
            )
            const out: Issue.Issue = Arr.isArrayNonEmpty(issues)
              ? issue._tag === "Composite" && issue.ast === ast
                ? new Issue.Composite(ast, issue.actual, [...issue.issues, ...issues])
                : new Issue.Composite(ast, ou, [issue, ...issues])
              : issue
            return Effect.fail(out)
          })
        }
        sroa = Effect.flatMapEager(sroa, (oa) => {
          if (Option.isSome(oa)) {
            const value = oa.value
            const issues: Array<Issue.Issue> = []

            AST.collectIssues(checks, value, issues, ast, options)

            if (Arr.isArrayNonEmpty(issues)) {
              return Effect.fail(new Issue.Composite(ast, oa, issues))
            }
          }
          return Effect.succeed(oa)
        })
      }

      return sroa
    }
  }
)
