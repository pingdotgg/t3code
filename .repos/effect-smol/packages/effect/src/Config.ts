/**
 * Descriptions of configuration values that can be read from a
 * `ConfigProvider`. A `Config<T>` explains which keys to read, how to decode
 * and validate them, and how to combine defaults, fallbacks, nested paths, and
 * multiple settings. Configs are also Effects, so they can be yielded in
 * `Effect.gen` after a provider has been supplied.
 *
 * @since 4.0.0
 */
import type { Path, SourceError } from "./ConfigProvider.ts"
import * as ConfigProvider from "./ConfigProvider.ts"
import * as Effect from "./Effect.ts"
import * as Effectable from "./Effectable.ts"
import { dual, memoize } from "./Function.ts"
import * as InternalRecord from "./internal/record.ts"
import * as LogLevel_ from "./LogLevel.ts"
import * as Option from "./Option.ts"
import * as Predicate from "./Predicate.ts"
import * as Rec from "./Record.ts"
import * as Result from "./Result.ts"
import * as Schema from "./Schema.ts"
import * as SchemaAST from "./SchemaAST.ts"
import * as SchemaGetter from "./SchemaGetter.ts"
import * as SchemaIssue from "./SchemaIssue.ts"
import * as SchemaParser from "./SchemaParser.ts"
import * as SchemaTransformation from "./SchemaTransformation.ts"

const TypeId = "~effect/Config"

/**
 * Returns `true` if `u` is a `Config` instance.
 *
 * **When to use**
 *
 * Use when you need to distinguish a `Config` from an unknown value before
 * calling `.parse` or {@link unwrap}.
 *
 * **Example** (Checking Config values)
 *
 * ```ts import.meta.vitest
 * import { Config } from "effect"
 *
 * Config.isConfig(Config.string("HOST")) // => true
 * Config.isConfig("not a config") // => false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isConfig = (u: unknown): u is Config<unknown> => Predicate.hasProperty(u, TypeId)

/**
 * Represents the error type produced when config loading or validation fails.
 *
 * **When to use**
 *
 * Use when you need to inspect config loading or validation failures.
 *
 * **Details**
 *
 * Wraps either:
 * - A `SourceError` — the provider could not read data (I/O failure).
 * - A `SchemaError` — the data was found but did not match the schema
 *   (wrong type, out of range, missing key, etc.).
 *
 * @see {@link orElse} – recover from a ConfigError
 * @see {@link withDefault} – provide a fallback when relevant input is absent
 *
 * @category errors
 * @since 4.0.0
 */
export class ConfigError {
  readonly _tag = "ConfigError"
  readonly name: string = "ConfigError"
  readonly cause: SourceError | Schema.SchemaError
  constructor(cause: SourceError | Schema.SchemaError) {
    this.cause = cause
  }
  get message() {
    return this.cause.toString()
  }
  toString() {
    return `ConfigError(${this.message})`
  }
}

/**
 * A recipe for extracting a typed value `T` from a `ConfigProvider`.
 *
 * **When to use**
 *
 * Use to describe typed configuration that can be parsed from a provider or
 * yielded inside `Effect.gen`.
 *
 * **Details**
 *
 * Key members:
 * - `parse(provider)` – runs the config against a specific provider.
 * - Yieldable – can be yielded inside `Effect.gen`, which automatically
 *   resolves the current `ConfigProvider` from the context.
 * - Pipeable – supports `.pipe(Config.map(...))` etc.
 *
 * @see {@link schema} – the main way to create a Config
 *
 * @category models
 * @since 2.0.0
 */
export interface Config<out T> extends Effect.Effect<T, ConfigError> {
  readonly [TypeId]: typeof TypeId
  readonly parse: (provider: ConfigProvider.ConfigProvider) => Effect.Effect<T, ConfigError>
}

// Config composition needs to distinguish an absent recipe from a hard failure
// before the public Effect error channel is finalized. `hasInput` records
// provider evidence separately from the value, because successful values such
// as `undefined` and values supplied by defaults are not evidence of input.
// Hard failures carry the same evidence so recovery cannot erase it.
interface Resolved<out T> {
  readonly _tag: "Resolved"
  readonly value: T
  readonly hasInput: boolean
}

interface Absent {
  readonly _tag: "Absent"
  readonly error: ConfigError
}

type Resolution<T> = Resolved<T> | Absent

interface EvaluationFailure {
  readonly error: ConfigError
  readonly hasInput: boolean
}

type Evaluator<T> = (
  provider: ConfigProvider.ConfigProvider,
  pathPrefix: Path
) => Effect.Effect<Resolution<T>, EvaluationFailure>

interface ConfigImpl<out T> extends Config<T> {
  readonly evaluator: Evaluator<T>
}

const Proto = {
  ...Effectable.Prototype<Config<any>>({
    label: "Config",
    evaluate(fiber) {
      return this.parse(fiber.getRef(ConfigProvider.ConfigProvider))
    }
  }),
  [TypeId]: TypeId,
  toJSON(this: Config<unknown>) {
    return {
      _id: "Config"
    }
  }
}

function make<T>(
  evaluator: Evaluator<T>
): Config<T> {
  const self = Object.create(Proto)
  self.evaluator = evaluator
  self.parse = (provider: ConfigProvider.ConfigProvider) =>
    evaluator(provider, []).pipe(
      Effect.mapErrorEager((failure) => failure.error),
      Effect.flatMapEager((resolution) =>
        resolution._tag === "Resolved" ? Effect.succeed(resolution.value) : Effect.fail(resolution.error)
      )
    )
  return self
}

const evaluateAt = <T>(
  self: Config<T>,
  provider: ConfigProvider.ConfigProvider,
  pathPrefix: Path
): Effect.Effect<Resolution<T>, EvaluationFailure> => (self as ConfigImpl<T>).evaluator(provider, pathPrefix)

const resolved = <T>(value: T, hasInput: boolean): Resolution<T> => ({
  _tag: "Resolved",
  value,
  hasInput
})

const absent = (error: ConfigError): Absent => ({
  _tag: "Absent",
  error
})

const evaluationFailure = (error: ConfigError, hasInput: boolean): EvaluationFailure => ({
  error,
  hasInput
})

const isSourceError = (u: unknown): u is ConfigProvider.SourceError => Predicate.isTagged(u, "SourceError")

const catchSourceError = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  hasInput: boolean
): Effect.Effect<A, E | EvaluationFailure, R> =>
  self.pipe(
    Effect.catchDefect((defect) =>
      isSourceError(defect)
        ? Effect.fail(evaluationFailure(new ConfigError(defect), hasInput))
        : Effect.die(defect)
    )
  )

const preserveInputEvidence = <T>(
  self: Effect.Effect<Resolution<T>, EvaluationFailure>,
  hasInput: boolean
): Effect.Effect<Resolution<T>, EvaluationFailure> => {
  if (!hasInput) return self
  return self.pipe(
    Effect.mapErrorEager((failure) => evaluationFailure(failure.error, true)),
    Effect.flatMapEager((resolution) =>
      resolution._tag === "Resolved"
        ? Effect.succeed(resolved(resolution.value, true))
        : Effect.fail(evaluationFailure(resolution.error, true))
    )
  )
}

/**
 * Transforms the parsed value of a config with a pure function.
 *
 * **When to use**
 *
 * Use when you need to transform a parsed config value with a function that
 * cannot fail.
 *
 * **Example** (Uppercasing a string config)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const upper = Config.string("name").pipe(
 *   Config.map((s) => s.toUpperCase())
 * )
 *
 * const provider = ConfigProvider.fromUnknown({ name: "alice" })
 * Effect.runSync(upper.parse(provider)) // => "ALICE"
 * ```
 *
 * @see {@link mapOrFail} – when the transformation can fail
 *
 * @category mapping
 * @since 2.0.0
 */
export const map: {
  <A, B>(f: (a: A) => B): (self: Config<A>) => Config<B>
  <A, B>(self: Config<A>, f: (a: A) => B): Config<B>
} = dual(2, <A, B>(self: Config<A>, f: (a: A) => B): Config<B> => {
  return make((provider, pathPrefix) =>
    Effect.map(evaluateAt(self, provider, pathPrefix), (resolution) =>
      resolution._tag === "Resolved"
        ? resolved(f(resolution.value), resolution.hasInput)
        : resolution)
  )
})

/**
 * Transforms the parsed value with a function that may fail.
 *
 * **When to use**
 *
 * Use when you need to transform a parsed config value with a function that can
 * produce a `ConfigError` (e.g. parsing a URL, checking a range).
 *
 * **Example** (Wrapping a value in an effectful transformation)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const trimmed = Config.string("name").pipe(
 *   Config.mapOrFail((s) => Effect.succeed(s.trim()))
 * )
 * const provider = ConfigProvider.fromUnknown({ name: " Alice " })
 * Effect.runSync(trimmed.parse(provider)) // => "Alice"
 * ```
 *
 * @see {@link map} – when the transformation cannot fail
 *
 * @category mapping
 * @since 2.0.0
 */
export const mapOrFail: {
  <A, B>(f: (a: A) => Effect.Effect<B, ConfigError>): (self: Config<A>) => Config<B>
  <A, B>(self: Config<A>, f: (a: A) => Effect.Effect<B, ConfigError>): Config<B>
} = dual(2, <A, B>(self: Config<A>, f: (a: A) => Effect.Effect<B, ConfigError>): Config<B> => {
  return make((provider, pathPrefix) =>
    Effect.flatMap(evaluateAt(self, provider, pathPrefix), (resolution) =>
      resolution._tag === "Resolved"
        ? f(resolution.value).pipe(
          Effect.mapEager((value) => resolved(value, resolution.hasInput)),
          Effect.mapErrorEager((error) => evaluationFailure(error, resolution.hasInput))
        )
        : Effect.succeed(resolution))
  )
})

/**
 * Provides a fallback config when parsing fails with a `ConfigError`.
 *
 * **When to use**
 *
 * Use when you need to try an alternative config source after the primary one
 * fails.
 *
 * **Details**
 *
 * Unlike {@link withDefault}, this handles both semantic absence and **all**
 * `ConfigError`s. The fallback function receives the error and returns a new
 * `Config`.
 *
 * **Gotchas**
 *
 * Recovery preserves whether the primary config read provider input. When the
 * recovered config is composed with {@link all}, invalid input in the primary
 * branch still makes the enclosing group partially supplied, so an outer
 * {@link withDefault} or {@link option} does not replace the whole group.
 *
 * **Example** (Falling back to a literal)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const hostConfig = Config.string("HOST").pipe(
 *   Config.orElse(() => Config.succeed("localhost"))
 * )
 * const provider = ConfigProvider.fromUnknown({})
 * Effect.runSync(hostConfig.parse(provider)) // => "localhost"
 * ```
 *
 * @see {@link withDefault} – fallback only on semantic absence
 *
 * @category combinators
 * @since 2.0.0
 */
export const orElse: {
  <A2>(that: (error: ConfigError) => Config<A2>): <A>(self: Config<A>) => Config<A2 | A>
  <A, A2>(self: Config<A>, that: (error: ConfigError) => Config<A2>): Config<A | A2>
} = dual(2, <A, A2>(self: Config<A>, that: (error: ConfigError) => Config<A2>): Config<A | A2> => {
  return make<A | A2>((provider, pathPrefix) =>
    Effect.matchEffect(evaluateAt(self, provider, pathPrefix), {
      onFailure: (failure) =>
        preserveInputEvidence(
          evaluateAt(that(failure.error), provider, pathPrefix),
          failure.hasInput
        ),
      onSuccess: (resolution): Effect.Effect<Resolution<A | A2>, EvaluationFailure> =>
        resolution._tag === "Absent"
          ? evaluateAt(that(resolution.error), provider, pathPrefix)
          : Effect.succeed(resolution)
    })
  )
})

/**
 * Combines multiple configs into a single config that parses all of them.
 *
 * **When to use**
 *
 * Use when you need to group related configs into a tuple or named struct.
 *
 * **Details**
 *
 * Accepts a tuple (preserves positions), an iterable, or a record of configs.
 * Returns a config whose parsed value mirrors the input shape.
 *
 * A combined config is absent when at least one child cannot resolve and none
 * of the other children read provider input. This lets {@link withDefault} and
 * {@link option} handle a wholly absent group. Once any child reads input, a
 * missing sibling makes the group incomplete and parsing fails. Values supplied
 * by child defaults do not count as provider input.
 *
 * Unlike a `Schema.Struct` passed to {@link schema}, `all` only considers input
 * read by its children. An explicitly present but empty parent container does
 * not by itself make the group present.
 *
 * **Example** (Combining configs as a struct)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const dbConfig = Config.all({
 *   host: Config.string("host"),
 *   port: Config.number("port")
 * })
 *
 * const provider = ConfigProvider.fromUnknown({ host: "localhost", port: 5432 })
 * Effect.runSync(dbConfig.parse(provider)) // => { host: "localhost", port: 5432 }
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export function all<const Arg extends Iterable<Config<any>> | Record<string, Config<any>>>(
  arg: Arg
): Config<
  [Arg] extends [ReadonlyArray<Config<any>>] ? {
      -readonly [K in keyof Arg]: [Arg[K]] extends [Config<infer A>] ? A : never
    }
    : [Arg] extends [Iterable<Config<infer A>>] ? Array<A>
    : [Arg] extends [Record<string, Config<any>>] ? {
        -readonly [K in keyof Arg]: [Arg[K]] extends [Config<infer A>] ? A : never
      }
    : never
> {
  const configs: Array<Config<any>> | Record<string, Config<any>> = Array.isArray(arg)
    ? arg
    : Symbol.iterator in arg
    ? [...arg as any]
    : arg
  if (Array.isArray(configs)) {
    return make((provider, pathPrefix) =>
      Effect.flatMapEager(
        Effect.all(configs.map((config) => Effect.result(evaluateAt(config, provider, pathPrefix)))),
        resolveArray
      )
    ) as any
  } else {
    return make((provider, pathPrefix) =>
      Effect.flatMapEager(
        Effect.all(Rec.map(configs, (config) => Effect.result(evaluateAt(config, provider, pathPrefix)))),
        resolveRecord
      )
    ) as any
  }
}

const resolveArray = (
  results: ReadonlyArray<Result.Result<Resolution<any>, EvaluationFailure>>
): Effect.Effect<Resolution<Array<any>>, EvaluationFailure> => {
  const values: Array<any> = []
  let firstFailure: EvaluationFailure | undefined
  let firstAbsent: Absent | undefined
  let hasInput = false
  for (const result of results) {
    if (Result.isFailure(result)) {
      firstFailure ??= result.failure
      hasInput = hasInput || result.failure.hasInput
      continue
    }
    const resolution = result.success
    if (resolution._tag === "Absent") {
      firstAbsent ??= resolution
    } else {
      values.push(resolution.value)
      hasInput = hasInput || resolution.hasInput
    }
  }
  if (firstFailure !== undefined) {
    return Effect.fail(evaluationFailure(firstFailure.error, hasInput))
  }
  if (firstAbsent !== undefined) {
    return hasInput ? Effect.fail(evaluationFailure(firstAbsent.error, true)) : Effect.succeed(firstAbsent)
  }
  return Effect.succeed(resolved(values, hasInput))
}

const resolveRecord = (
  results: Record<string, Result.Result<Resolution<any>, EvaluationFailure>>
): Effect.Effect<Resolution<Record<string, any>>, EvaluationFailure> => {
  const values: Record<string, any> = {}
  let firstFailure: EvaluationFailure | undefined
  let firstAbsent: Absent | undefined
  let hasInput = false
  for (const key in results) {
    const result = results[key]
    if (Result.isFailure(result)) {
      firstFailure ??= result.failure
      hasInput = hasInput || result.failure.hasInput
      continue
    }
    const resolution = result.success
    if (resolution._tag === "Absent") {
      firstAbsent ??= resolution
    } else {
      InternalRecord.assignProperty(values, key, resolution.value)
      hasInput = hasInput || resolution.hasInput
    }
  }
  if (firstFailure !== undefined) {
    return Effect.fail(evaluationFailure(firstFailure.error, hasInput))
  }
  if (firstAbsent !== undefined) {
    return hasInput ? Effect.fail(evaluationFailure(firstAbsent.error, true)) : Effect.succeed(firstAbsent)
  }
  return Effect.succeed(resolved(values, hasInput))
}

/**
 * Provides a fallback value when the config cannot resolve because none of its
 * relevant input is present.
 *
 * **When to use**
 *
 * Use when you need to make a config key optional with a sensible default.
 *
 * **Gotchas**
 *
 * Validation errors and partially supplied groups still propagate. A schema
 * that successfully decodes absent input also keeps its decoded value instead
 * of using the default. Schema configs first represent a missing or
 * incompatible provider shape as `undefined`; the default is used only when
 * the schema rejects that value and no relevant input was found.
 *
 * **Example** (Defaulting a missing port)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const port = Config.number("port").pipe(Config.withDefault(3000))
 *
 * const provider = ConfigProvider.fromUnknown({})
 * Effect.runSync(port.parse(provider)) // => 3000
 * ```
 *
 * @see {@link option} – returns `Option` instead of a default value
 * @see {@link orElse} – catches all errors, not just absent input
 *
 * @category combinators
 * @since 2.0.0
 */
export const withDefault: {
  <const A2>(defaultValue: A2): <A>(self: Config<A>) => Config<A2 | A>
  <A, const A2>(self: Config<A>, defaultValue: A2): Config<A | A2>
} = dual(2, <A, const A2>(self: Config<A>, defaultValue: A2): Config<A | A2> => {
  return make<A | A2>((provider, pathPrefix) =>
    Effect.mapEager(
      evaluateAt(self, provider, pathPrefix),
      (resolution) => resolution._tag === "Absent" ? resolved(defaultValue, false) : resolution
    )
  )
})

/**
 * Makes a config optional: returns `Some(value)` on success and `None` when the
 * config cannot resolve because none of its relevant input is present.
 *
 * **When to use**
 *
 * Use when you need to handle a config key that may or may not be present.
 *
 * **Gotchas**
 *
 * Validation errors and partially supplied groups still propagate. Successful
 * values are always wrapped in `Some`, including `undefined` when the schema
 * explicitly accepts it. Schema configs first represent a missing or
 * incompatible provider shape as `undefined`; `None` is returned only when the
 * schema rejects that value and no relevant input was found.
 *
 * **Example** (Reading optional config)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect, Option } from "effect"
 *
 * const maybePort = Config.option(Config.number("port"))
 *
 * const provider = ConfigProvider.fromUnknown({})
 * Effect.runSync(maybePort.parse(provider)) // => Option.none()
 * ```
 *
 * @see {@link withDefault} – provide a concrete fallback value instead
 *
 * @category combinators
 * @since 2.0.0
 */
export const option = <A>(self: Config<A>): Config<Option.Option<A>> =>
  self.pipe(map(Option.some), withDefault(Option.none()))

/**
 * Extracts the successfully parsed value type from a `Config`.
 *
 * **When to use**
 *
 * Use to derive the parsed value type from an existing `Config` value when
 * declaring reusable config-driven types.
 *
 * @see {@link Config} for the config type whose parsed value is extracted
 * @see {@link Effect.Success} for extracting the success type from any `Effect`
 *
 * @category utility types
 * @since 2.5.0
 */
export type Success<T> = [T] extends [Config<infer A>] ? A : never

/**
 * Utility type that recursively replaces primitives with `Config` in a nested
 * structure.
 *
 * **When to use**
 *
 * Use when typing the input of {@link unwrap} so callers can pass either a `Config`
 *   or a record of `Config`s.
 *
 * **Details**
 *
 * `Config.Wrap<{ key: string }>` becomes `{ key: Config<string> } | Config<{ key: string }>`
 *
 * @see {@link unwrap} – construct a `Config` from a `Wrap<T>`
 *
 * @category utility types
 * @since 2.0.0
 */
export type Wrap<A> = [NonNullable<A>] extends [infer T] ? [IsPlainObject<T>] extends [true] ?
      | { readonly [K in keyof A]: Wrap<A[K]> }
      | Config<A>
  : Config<A>
  : Config<A>

type IsPlainObject<A> = [A] extends [Record<string, any>]
  ? [keyof A] extends [never] ? false : [keyof A] extends [string] ? true : false
  : false

/**
 * Constructs a `Config<T>` from a value matching `Wrap<T>`.
 *
 * **When to use**
 *
 * Use when accepting config from callers who may pass either a single `Config` or a
 *   record of individual `Config`s.
 *
 * **Details**
 *
 * If the input is already a `Config`, it is returned as-is. Otherwise, each
 * key is recursively unwrapped and combined.
 *
 * **Example** (Unwrapping a record of configs)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * interface Options {
 *   key: string
 * }
 *
 * const makeConfig = (config: Config.Wrap<Options>): Config.Config<Options> =>
 *   Config.unwrap(config)
 *
 * const config = makeConfig({ key: Config.string("key") })
 * const provider = ConfigProvider.fromUnknown({ key: "value" })
 * Effect.runSync(config.parse(provider)) // => { key: "value" }
 * ```
 *
 * @see {@link Wrap} – the utility type accepted by this function
 *
 * @category converting
 * @since 2.0.0
 */
export const unwrap = <T>(wrapped: Wrap<T>): Config<T> => {
  if (isConfig(wrapped)) return wrapped
  return all(Rec.map(wrapped as Record<string, Wrap<any>>, (config) => unwrap(config))) as Config<T>
}

// -----------------------------------------------------------------------------
// schema
// -----------------------------------------------------------------------------

interface ConfigCursor {
  readonly provider: ConfigProvider.ConfigProvider
  readonly path: Path
  readonly node: ConfigProvider.Node | undefined
  readonly toString: () => string
}

const cursorToString = (): string => "<configuration>"

const loadCursor: (
  provider: ConfigProvider.ConfigProvider,
  path: Path
) => Effect.Effect<ConfigCursor> = (provider, path) =>
  provider.load(path).pipe(
    Effect.orDie,
    Effect.mapEager((node) => ({ provider, path, node, toString: cursorToString }))
  )

const loadChildCursor = (cursor: ConfigCursor, segment: string | number): Effect.Effect<ConfigCursor> =>
  loadCursor(cursor.provider, [...cursor.path, segment])

const getScalar = (node: ConfigProvider.Node | undefined): string | undefined => node?.value

const decodeFromCursor = (
  ast: SchemaAST.AST,
  decode: (cursor: ConfigCursor) => Effect.Effect<unknown, SchemaIssue.Issue>
): SchemaAST.AST =>
  SchemaAST.decodeTo(
    SchemaAST.unknown,
    ast,
    new SchemaTransformation.Transformation(
      SchemaGetter.transformOrFail((input: unknown) => decode(input as ConfigCursor)),
      SchemaGetter.passthrough()
    )
  )

const isScalarInput = (ast: SchemaAST.AST): boolean => {
  switch (ast._tag) {
    case "Union":
      return ast.types.every(isScalarInput)
    case "Objects":
    case "Arrays":
    case "Suspend":
      return false
    default:
      return true
  }
}

const hasProviderInput = (
  ast: SchemaAST.AST,
  node: ConfigProvider.Node | undefined
): boolean => {
  switch (ast._tag) {
    case "Objects":
      return node?._tag === "Record"
    case "Arrays":
      return node?._tag === "Array"
    case "Union":
      return ast.types.some((ast) => hasProviderInput(ast, node))
    case "Suspend":
      return hasProviderInput(ast.thunk(), node)
    default:
      return getScalar(node) !== undefined
  }
}

const toConfigCursorAST = memoize((root: SchemaAST.AST): SchemaAST.AST => {
  const seen = new WeakSet<SchemaAST.AST>()
  const recur = SchemaAST.applyToSelfOrLastLinkEncoding((ast) => {
    seen.add(ast)
    switch (ast._tag) {
      case "Objects": {
        const matchesIndex = ast.indexSignatures.map((is) => SchemaParser._is(is.parameter))
        const materialize = Effect.fnUntraced(function*(cursor: ConfigCursor) {
          if (cursor.node?._tag !== "Record") {
            return undefined
          }
          const node = cursor.node
          const keys = new Set<string>()
          for (const property of ast.propertySignatures) {
            if (typeof property.name === "string") keys.add(property.name)
          }
          if (matchesIndex.length > 0) {
            for (const key of node.keys) {
              if (matchesIndex.some((matches) => matches(key))) keys.add(key)
            }
          }
          const out: Record<string, ConfigCursor> = {}
          for (const key of keys) {
            const child = yield* loadChildCursor(cursor, key)
            if (child.node !== undefined) InternalRecord.assignProperty(out, key, child)
          }
          return out
        })
        return decodeFromCursor(ast.recur(recur, (ast) => ast), materialize)
      }
      case "Arrays": {
        const materialize = Effect.fnUntraced(function*(cursor: ConfigCursor) {
          if (cursor.node?._tag !== "Array") {
            return undefined
          }
          const out: Array<ConfigCursor> = []
          for (let i = 0; i < cursor.node.length; i++) {
            out.push(yield* loadChildCursor(cursor, i))
          }
          return out
        })
        return decodeFromCursor(ast.recur(recur), materialize)
      }
      case "Union":
        for (const member of ast.types) {
          recur(member)
        }
        return isScalarInput(ast)
          ? decodeFromCursor(ast, (cursor) => Effect.succeed(getScalar(cursor.node)))
          : ast.recur(recur)
      case "Suspend": {
        const target = ast.thunk()
        // Force new branches so opaque encodings fail when the Config is constructed.
        if (!seen.has(target)) recur(target)
        return ast.recur(recur)
      }
      case "Declaration":
      case "Any":
        throw new globalThis.Error("Config.schema does not support opaque StringTree encodings", { cause: ast })
      default:
        return decodeFromCursor(ast, (cursor) => Effect.succeed(getScalar(cursor.node)))
    }
  })
  return recur(root)
})

/**
 * Creates a `Config<T>` from a `Schema.Codec`.
 *
 * **When to use**
 *
 * Use when you need to read structured or schema-validated configuration.
 *
 * **Details**
 *
 * The optional `path` sets the local path segment(s) for the config lookup.
 * It is appended to the logical path prefix accumulated from outer
 * {@link nested} calls. Pass a single string for a flat key or an array for
 * nested paths.
 *
 * Convenience constructors such as `string`, `number`, and `boolean` delegate
 * to this API.
 *
 * The codec is converted to its canonical `StringTree` form. Its encoded shape
 * determines how provider data is loaded: scalar schemas read a co-located
 * scalar value, object schemas read declared properties and matching record
 * keys, and array schemas read indexed children. A mixed-shape union loads each
 * member according to that member's shape before applying the union's mode and
 * checks.
 *
 * At the config's lookup path, a missing node or a node that cannot provide the
 * representation required by the schema is decoded as `undefined`. Missing
 * object properties remain omitted so the schema's property semantics still
 * apply. Decoding success always wins, even when no provider input was found.
 * For example,
 * `Schema.UndefinedOr(Schema.String)` decodes to `undefined` and is not replaced
 * by {@link withDefault}. If decoding fails and no relevant representation was
 * found, the config is absent. Invalid data in a relevant representation is a
 * validation failure. Provider `SourceError`s are always failures.
 *
 * **Gotchas**
 *
 * Plain `Schema.Array` and `Schema.Record` schemas use structural provider
 * input. Use {@link Array} or {@link Record} when a flat separated string must
 * also be accepted.
 *
 * `Schema.Struct` and {@link all} describe different lookup models. An
 * explicitly present empty object is relevant input for a struct and required
 * fields are validated. The same empty parent container does not make an
 * `all` group present when all of its child configs are absent.
 *
 * The canonical `StringTree` encoding must expose a concrete scalar, object,
 * array, or union shape. Opaque encodings such as `Schema.Any`,
 * `Schema.Unknown`, `Schema.ObjectKeyword`, `Schema.Json`, and
 * `Schema.MutableJson` are rejected synchronously when this config is
 * constructed, including when they are nested in another schema. Suspended
 * recursive schemas remain supported when their eventual shape is concrete.
 * Declarations such as `Schema.URL` also remain supported when their canonical
 * encoding has a concrete shape. To read arbitrary JSON from one scalar value,
 * use `Schema.fromJsonString(Schema.Json)`.
 *
 * **Example** (Reading a structured config)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect, Schema } from "effect"
 *
 * const DbConfig = Config.schema(
 *   Schema.Struct({
 *     host: Schema.String,
 *     port: Schema.Int
 *   }),
 *   "db"
 * )
 *
 * const provider = ConfigProvider.fromUnknown({
 *   db: { host: "localhost", port: 5432 }
 * })
 *
 * Effect.runSync(DbConfig.parse(provider)) // => { host: "localhost", port: 5432 }
 * ```
 *
 * @see {@link string} / {@link number} / {@link boolean} – shortcuts for
 *   single-value configs
 *
 * @category schemas
 * @since 4.0.0
 */
export function schema<T>(codec: Schema.ConstraintCodec<T, unknown>, path?: string | ConfigProvider.Path): Config<T> {
  const codecStringTree = Schema.toCodecStringTree(codec)
  const encodedAst = SchemaAST.toEncoded(codecStringTree.ast)
  const decodeCursor = SchemaParser.decodeUnknownEffect(
    Schema.make<Schema.Codec<T, ConfigCursor>>(toConfigCursorAST(codecStringTree.ast))
  )
  const localPath = typeof path === "string" ? [path] : path ?? []
  return make((provider, pathPrefix) => {
    const fullPath = [...pathPrefix, ...localPath]
    return catchSourceError(loadCursor(provider, fullPath), false).pipe(
      Effect.flatMapEager((cursor) => {
        const hasInput = hasProviderInput(encodedAst, cursor.node)
        return catchSourceError(
          decodeCursor(cursor).pipe(
            Effect.mapEager((value) => resolved(value, hasInput)),
            Effect.catchEager((issue) => {
              const error = new ConfigError(
                new Schema.SchemaError(fullPath.length > 0 ? new SchemaIssue.Pointer(fullPath, issue) : issue)
              )
              return hasInput
                ? Effect.fail(evaluationFailure(error, true))
                : Effect.succeed(absent(error))
            })
          ),
          hasInput
        )
      })
    )
  })
}

/** @internal */
export const TrueValues = Schema.Literals(["true", "yes", "on", "1", "y"])

/** @internal */
export const FalseValues = Schema.Literals(["false", "no", "off", "0", "n"])

/**
 * Schema for boolean values encoded as strings.
 *
 * **When to use**
 *
 * Use when you need the reusable boolean schema value for `Config.schema` with
 * custom paths.
 *
 * **Details**
 *
 * Accepted string values: `true`, `false`, `yes`, `no`, `on`, `off`, `1`,
 * `0`, `y`, `n` (case-sensitive).
 *
 * @see {@link boolean} – convenience constructor
 *
 * @category schemas
 * @since 4.0.0
 */
export const Boolean = Schema.Literals([...TrueValues.literals, ...FalseValues.literals]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (value) => value === "true" || value === "yes" || value === "on" || value === "1" || value === "y",
      encode: (value) => value ? "true" : "false"
    })
  )
)

/**
 * Schema for port numbers (integers in 1–65535).
 *
 * **When to use**
 *
 * Use when you need the reusable port schema value for `Config.schema` with
 * custom paths.
 *
 * @see {@link port} – convenience constructor
 *
 * @category schemas
 * @since 4.0.0
 */
export const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))

/**
 * Schema for `LogLevel` string literals.
 *
 * **When to use**
 *
 * Use when you need the reusable log-level schema value for `Config.schema`
 * with custom paths.
 *
 * **Details**
 *
 * Accepted values: `"All"`, `"Fatal"`, `"Error"`, `"Warn"`, `"Info"`,
 * `"Debug"`, `"Trace"`, `"None"`.
 *
 * @see {@link logLevel} – convenience constructor
 *
 * @category schemas
 * @since 4.0.0
 */
export const LogLevel = Schema.Literals(LogLevel_.values)

/**
 * Schema for key-value record types that can also be parsed from
 * a flat comma-separated string.
 *
 * **When to use**
 *
 * Use when reading key-value maps from a single env var (e.g. OpenTelemetry
 *   resource attributes).
 *
 * **Details**
 *
 * Accepts either a JSON-like record from the provider or a flat string like
 * `"key1=val1,key2=val2"`. The `separator` (default `","`) and
 * `keyValueSeparator` (default `"="`) can be customized.
 *
 * **Example** (Parsing a comma-separated record)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect, Schema } from "effect"
 *
 * const schema = Config.Record(Schema.String, Schema.String)
 * const config = Config.schema(schema, "OTEL_RESOURCE_ATTRIBUTES")
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     OTEL_RESOURCE_ATTRIBUTES:
 *       "service.name=my-service,service.version=1.0.0,custom.attribute=value"
 *   }
 * })
 *
 * const result = Effect.runSync(config.parse(provider))
 * result["service.name"] // => "my-service"
 * result["service.version"] // => "1.0.0"
 * result["custom.attribute"] // => "value"
 * ```
 *
 * @see {@link Array} for separated or structural array input
 *
 * @category schemas
 * @since 4.0.0
 */
export const Record = <K extends Schema.Record.Key, V extends Schema.Constraint>(key: K, value: V, options?: {
  readonly separator?: string | undefined
  readonly keyValueSeparator?: string | undefined
}) => {
  const record = Schema.Record(key, value)
  const split = SchemaTransformation.splitKeyValue(options)
  const recordString = Schema.String.pipe(
    Schema.decodeTo(Schema.toCodecStringTree(record), {
      decode: split.decode,
      encode: SchemaGetter.passthrough<Record<string, string>, Schema.StringTree>({ strict: false }).compose(
        split.encode
      )
    })
  )

  return Schema.Union([record, recordString])
}

const ArrayConfig = <V extends Schema.Constraint>(value: V, options?: {
  readonly separator?: string | undefined
}) => {
  const array = Schema.Array(value)
  const separator = options?.separator ?? ","
  const arrayString = Schema.String.pipe(
    Schema.decodeTo(Schema.toCodecStringTree(array), {
      decode: SchemaGetter.split(options),
      encode: SchemaGetter.passthrough<ReadonlyArray<string>, Schema.StringTree>({ strict: false }).compose(
        SchemaGetter.transform((input) => input.join(separator))
      )
    })
  )

  return Schema.Union([arrayString, array])
}

export {
  /**
   * Schema for array types that can also be parsed from a flat separated string.
   *
   * **When to use**
   *
   * Use when reading array values from a single env var, such as comma-separated
   * exporter names.
   *
   * **Details**
   *
   * Accepts either a JSON-like array from the provider or a flat string like
   * `"a,b,c"`. The `separator` defaults to `","` and can be customized.
   *
   * @see {@link Record} for separated or structural record input
   *
   * @category schemas
   * @since 4.0.0
   */
  ArrayConfig as Array
}

// -----------------------------------------------------------------------------
// constructors
// -----------------------------------------------------------------------------

/**
 * Creates a config that always fails with the given error.
 *
 * **When to use**
 *
 * Use when you need to re-raise a specific config error, such as inside
 * {@link orElse}.
 *
 * @category constructors
 * @since 2.0.0
 */
export function fail(err: SourceError | Schema.SchemaError) {
  return make(() => Effect.fail(evaluationFailure(new ConfigError(err), false)))
}

/**
 * Creates a config that always succeeds with the given value, ignoring the
 * provider entirely.
 *
 * **When to use**
 *
 * Use when you need a hardcoded config value, such as inside {@link orElse} or
 * tests.
 *
 * **Example** (Returning a constant fallback)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const host = Config.string("HOST").pipe(
 *   Config.orElse(() => Config.succeed("localhost"))
 * )
 * const provider = ConfigProvider.fromUnknown({})
 * Effect.runSync(host.parse(provider)) // => "localhost"
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export function succeed<T>(value: T) {
  return make(() => Effect.succeed(resolved(value, false)))
}

/**
 * Creates a config for a single string value.
 *
 * **When to use**
 *
 * Use when reading a single string env var or config key.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Schema.String, name)`.
 *
 * **Example** (Reading a string config)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const host = Config.string("HOST")
 *
 * const provider = ConfigProvider.fromUnknown({ HOST: "localhost" })
 * Effect.runSync(host.parse(provider)) // => "localhost"
 * ```
 *
 * @see {@link nonEmptyString} – rejects empty strings
 * @see {@link schema} – for more complex types
 *
 * @category constructors
 * @since 2.0.0
 */
export function string(name?: string) {
  return schema(Schema.String, name)
}

/**
 * Creates a config for a non-empty string value. Fails if the value is an
 * empty string.
 *
 * **When to use**
 *
 * Use to read a string config value that must contain at least one character.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Schema.NonEmptyString, name)`.
 *
 * @see {@link string} for allowing empty strings
 *
 * @category constructors
 * @since 3.7.0
 */
export function nonEmptyString(name?: string) {
  return schema(Schema.NonEmptyString, name)
}

/**
 * Creates a config for a numeric value (including `NaN`, `Infinity`).
 *
 * **When to use**
 *
 * Use when you need config input to accept JavaScript's full number domain,
 * including NaN and infinities, rather than reject non-finite values.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Schema.Number, name)`.
 *
 * @see {@link finite} for rejecting `NaN` and `Infinity`
 * @see {@link int} for accepting only integers
 *
 * @category constructors
 * @since 2.0.0
 */
export function number(name?: string) {
  return schema(Schema.Number, name)
}

/**
 * Creates a config for a finite number (rejects `NaN` and `Infinity`).
 *
 * **When to use**
 *
 * Use to read a numeric config value that must be finite.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Schema.Finite, name)`.
 *
 * @see {@link number} for accepting `NaN` and `Infinity`
 * @see {@link int} for accepting only integers
 *
 * @category constructors
 * @since 4.0.0
 */
export function finite(name?: string) {
  return schema(Schema.Finite, name)
}

/**
 * Creates a config for an integer value. Rejects floats.
 *
 * **When to use**
 *
 * Use to read a numeric config value that must be an integer.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Schema.Int, name)`.
 *
 * @see {@link number} for accepting any number
 * @see {@link port} for accepting only integers in `1` through `65535`
 *
 * @category constructors
 * @since 4.0.0
 */
export function int(name?: string) {
  return schema(Schema.Int, name)
}

/**
 * Creates a config that only accepts a specific literal value.
 *
 * **When to use**
 *
 * Use to restrict a config to a single, specific literal value.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Schema.Literal(literal), name)`.
 *
 * **Example** (Restricting to a literal)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const env = Config.literal("production", "ENV")
 * const provider = ConfigProvider.fromUnknown({ ENV: "production" })
 * Effect.runSync(env.parse(provider)) // => "production"
 * ```
 *
 * @see {@link literals} – accepts multiple literal values
 * @category constructors
 * @since 2.0.0
 */
export function literal<L extends SchemaAST.LiteralValue>(literal: L, name?: string) {
  return schema(Schema.Literal(literal), name)
}

/**
 * Creates a config that only accepts one of the specified literal values.
 *
 * **When to use**
 *
 * Use to restrict a config to a fixed set of allowed literal values.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Schema.Literals(literals), name)`.
 *
 * **Example** (Restricting to a set of literals)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const env = Config.literals(["development", "production"], "ENV")
 * const provider = ConfigProvider.fromUnknown({ ENV: "development" })
 * Effect.runSync(env.parse(provider)) // => "development"
 * ```
 *
 * @see {@link literal} for accepting one specific literal value
 *
 * @category constructors
 * @since 4.0.0
 */
export function literals<const L extends ReadonlyArray<SchemaAST.LiteralValue>>(literals: L, name?: string) {
  return schema(Schema.Literals(literals), name)
}

/**
 * Creates a config for a boolean value parsed from common string
 * representations.
 *
 * **When to use**
 *
 * Use to read boolean flags from string-like config sources.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Config.Boolean, name)`.
 *
 * Accepted values: `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0`,
 * `y`, `n`.
 *
 * **Example** (Reading a boolean flag)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const program = Config.boolean("FEATURE_FLAG")
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     FEATURE_FLAG: "yes"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * ) // => true
 * ```
 *
 * @see {@link Boolean} for the underlying boolean codec
 *
 * @category constructors
 * @since 2.0.0
 */
export function boolean(name?: string) {
  return schema(Boolean, name)
}

/**
 * Creates a config for a `Duration` value parsed from a human-readable
 * string.
 *
 * **When to use**
 *
 * Use to read time duration settings such as timeouts, intervals, or TTLs.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Schema.DurationFromString, name)`.
 *
 * Accepts any string that `Duration.fromInput` can parse (e.g.
 * `"10 seconds"`, `"500 millis"`, `"Infinity"`, `"-Infinity"`).
 *
 * **Example** (Reading a duration)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Duration, Effect } from "effect"
 *
 * const program = Config.duration("DURATION").pipe(Effect.map(Duration.toMillis))
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     DURATION: "10 seconds"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * ) // => 10000
 * ```
 *
 * @see {@link schema} for decoding configuration values with a custom codec
 *
 * @category constructors
 * @since 2.5.0
 */
export function duration(name?: string) {
  return schema(Schema.DurationFromString, name)
}

/**
 * Creates a config for a port number (integer in 1–65535).
 *
 * **When to use**
 *
 * Use to read network port settings that must be valid port numbers.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Config.Port, name)`.
 *
 * **Example** (Reading a port)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const program = Config.port("PORT")
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     PORT: "8080"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * ) // => 8080
 * ```
 *
 * @see {@link int} for integer config values outside the port range
 * @see {@link Port} for the underlying port codec
 *
 * @category constructors
 * @since 3.16.0
 */
export function port(name?: string) {
  return schema(Port, name)
}

/**
 * Creates a config for a log level string.
 *
 * **When to use**
 *
 * Use to read Effect log-level settings from configuration.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Config.LogLevel, name)`.
 *
 * Accepted values: `"All"`, `"Fatal"`, `"Error"`, `"Warn"`, `"Info"`,
 * `"Debug"`, `"Trace"`, `"None"`.
 *
 * **Example** (Reading a log level)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const program = Config.logLevel("LOG_LEVEL")
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     LOG_LEVEL: "Info"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * ) // => "Info"
 * ```
 *
 * @see {@link LogLevel} for the underlying log-level codec
 *
 * @category constructors
 * @since 2.0.0
 */
export function logLevel(name?: string) {
  return schema(LogLevel, name)
}

/**
 * Creates a config for a redacted string value. The parsed result is wrapped
 * in a `Redacted` container that hides the value from logs and `toString`.
 *
 * **When to use**
 *
 * Use to read secret string settings that should not be exposed in logs or
 * string output.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Schema.Redacted(Schema.String), name)`.
 *
 * **Example** (Reading a secret)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const program = Config.redacted("API_KEY").pipe(Effect.map(String))
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     API_KEY: "sk-1234567890abcdef"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * ) // => "<redacted>"
 * ```
 *
 * @see {@link string} for non-secret string settings
 *
 * @category constructors
 * @since 2.0.0
 */
export function redacted(name?: string) {
  return schema(Schema.Redacted(Schema.String), name)
}

/**
 * Creates a config for a `URL` value parsed from a string.
 *
 * **When to use**
 *
 * Use to read configuration values that must be valid URL strings.
 *
 * **Details**
 *
 * This is a shortcut for `Config.schema(Schema.URL, name)`.
 *
 * **Gotchas**
 *
 * Fails if the string cannot be parsed by the `URL` constructor.
 *
 * **Example** (Reading a URL)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const program = Config.url("URL").pipe(Effect.map((url) => url.href))
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     URL: "https://example.com"
 *   }
 * })
 *
 * Effect.runSync(
 *   program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
 * ) // => "https://example.com/"
 * ```
 *
 * @see {@link schema} for decoding configuration values with a custom codec
 *
 * @category constructors
 * @since 3.11.0
 */
export function url(name?: string) {
  return schema(Schema.URL, name)
}

/**
 * Creates a config for a `Date` value parsed from a string.
 *
 * **When to use**
 *
 * Use to read date settings that must parse to valid `Date` values.
 *
 * **Details**
 *
 * Shortcut for `Config.schema(Schema.Date, name)`.
 *
 * **Gotchas**
 *
 * Fails with a `SchemaError` if the string produces an invalid `Date`.
 *
 * **Example** (Reading a date)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const createdAt = Config.date("CREATED_AT")
 *
 * const provider = ConfigProvider.fromUnknown({ CREATED_AT: "2024-01-15" })
 * Effect.runSync(createdAt.parse(provider)).toISOString() // => "2024-01-15T00:00:00.000Z"
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export function date(name?: string) {
  return schema(Schema.Date, name)
}

/**
 * Scopes a config under a named prefix.
 *
 * **When to use**
 *
 * Use when you need to group related config keys under a common namespace.
 *
 * **Details**
 *
 * The prefix is prepended to every key the inner config reads. With
 * `fromUnknown` this means an extra object level; with `fromEnv` it means
 * a `_`-separated prefix on env var names.
 *
 * Multiple `nested` calls compose: the outermost name becomes the
 * outermost path segment.
 *
 * **Example** (Nesting a struct config under `"database"`)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const dbConfig = Config.all({
 *   host: Config.string("host"),
 *   port: Config.number("port")
 * }).pipe(Config.nested("database"))
 *
 * const provider = ConfigProvider.fromUnknown({
 *   database: { host: "localhost", port: "5432" }
 * })
 * Effect.runSync(dbConfig.parse(provider)) // => { host: "localhost", port: 5432 }
 * ```
 *
 * **Example** (Reading env vars with a nested prefix)
 *
 * ```ts import.meta.vitest
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const host = Config.string("host").pipe(Config.nested("database"))
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: { database_host: "localhost" }
 * })
 * Effect.runSync(host.parse(provider)) // => "localhost"
 * ```
 *
 * @see {@link all} – combine multiple configs into a struct
 * @see {@link schema} – read structured config from a schema
 *
 * @category combinators
 * @since 2.0.0
 */
export const nested: {
  (name: string): <A>(self: Config<A>) => Config<A>
  <A>(self: Config<A>, name: string): Config<A>
} = dual(
  2,
  <A>(self: Config<A>, name: string): Config<A> =>
    make((provider, pathPrefix) => evaluateAt(self, provider, [...pathPrefix, name]))
)
