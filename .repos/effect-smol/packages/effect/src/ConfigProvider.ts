/**
 * Provides the data source layer for the `Config` module. A `ConfigProvider`
 * knows how to load raw configuration nodes from a backing store (environment
 * variables, JSON objects, `.env` files, file trees) and expose them through a
 * uniform `Node` interface that `Config` schemas consume.
 *
 * ## Mental model
 *
 * - **Node** – a discriminated union (`Value | Record | Array`) that describes
 *   what lives at a given path in the configuration tree.
 * - **Path** – an array of string or numeric segments used to address a node
 *   (e.g. `["database", "host"]`).
 * - **ConfigProvider** – an object with a `load(path)` method that resolves a
 *   path to a `Node | undefined`. Providers can be composed and transformed.
 * - **Context.Reference** – `ConfigProvider` is registered as a reference
 *   service that defaults to `fromEnv()`, so it works without explicit
 *   provision.
 * - **SourceError** – the typed error returned when a backing store is
 *   unreadable (I/O failure, permission error, etc.).
 *
 * ## Common tasks
 *
 * - Read from environment variables → {@link fromEnv}
 * - Read from a JSON / plain object → {@link fromUnknown}
 * - Parse a `.env` string → {@link fromDotEnvContents}
 * - Load a `.env` file → {@link fromDotEnv}
 * - Read from a directory tree → {@link fromDir}
 * - Build a custom provider → {@link make}
 * - Fall back to another provider → {@link orElse}
 * - Scope a provider under a prefix → {@link nested}
 * - Convert path segments to `CONSTANT_CASE` → {@link constantCase}
 * - Transform path segments arbitrarily → {@link mapInput}
 * - Install a provider as a Layer → {@link layer} / {@link layerAdd}
 *
 * ## Gotchas
 *
 * - `fromEnv` joins path segments with `_` for lookup **and** splits env var
 *   names on `_` to discover child keys. `DATABASE_HOST=x` is therefore
 *   accessible at both `["DATABASE_HOST"]` and `["DATABASE", "HOST"]`.
 * - Because of `_` splitting, querying a parent path like `["DATABASE"]`
 *   returns a `Record` node with child key `"HOST"`, even if no env var
 *   named `DATABASE` exists.
 * - When using `fromEnv` with schemas that use camelCase keys, pipe the
 *   provider through {@link constantCase} so `databaseHost` resolves to
 *   `DATABASE_HOST`.
 * - `orElse` only falls back when the primary provider returns `undefined`
 *   (path not found). It does **not** catch `SourceError`.
 * - `nested` prepends segments to the path *after* `mapInput` has run, so
 *   the order of composition matters.
 *
 * ## Quickstart
 *
 * **Example** (Reading config from environment variables)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: { APP_PORT: "3000", APP_HOST: "localhost" }
 * })
 *
 * const port = Config.number("port")
 *
 * const program = port.parse(
 *   provider.pipe(
 *     ConfigProvider.nested("app"),
 *     ConfigProvider.constantCase
 *   )
 * )
 *
 * // Effect.runSync(program) // 3000
 * ```
 *
 * @see {@link make} – build a provider from a lookup function
 * @see {@link fromEnv} – the default provider backed by `process.env`
 * @see {@link fromUnknown} – provider backed by a plain JS object
 *
 * @since 4.0.0
 */

import * as Context from "./Context.ts"
import * as Data from "./Data.ts"
import * as Effect from "./Effect.ts"
import * as FileSystem from "./FileSystem.ts"
import { format } from "./Formatter.ts"
import { dual, flow } from "./Function.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import * as Layer from "./Layer.ts"
import * as Path_ from "./Path.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { PlatformError } from "./PlatformError.ts"
import * as Predicate from "./Predicate.ts"
import type { Scope } from "./Scope.ts"
import * as Str from "./String.ts"

/**
 * A discriminated union describing the shape of a configuration value at a
 * given path.
 *
 * **When to use**
 *
 * Use when implementing a custom `ConfigProvider` by returning raw
 * nodes from the `get` callback passed to {@link make}, or when inspecting raw
 * provider output before schema parsing.
 *
 * **Details**
 *
 * `Value` is a terminal string leaf. `Record` is an object-like container
 * whose immediate child keys are known and may carry an optional co-located
 * `value`. `Array` is an indexed container with a known `length` and may also
 * carry an optional co-located `value`.
 *
 * @see {@link makeValue} – construct a `Value` node
 * @see {@link makeRecord} – construct a `Record` node
 * @see {@link makeArray} – construct an `Array` node
 *
 * @category models
 * @since 4.0.0
 */
export type Node =
  /** A terminal string value */
  | {
    readonly _tag: "Value"
    readonly value: string
  }
  /** An object; keys are unordered */
  | {
    readonly _tag: "Record"
    readonly keys: ReadonlySet<string>
    readonly value: string | undefined
  }
  /** An array-like container; length is the number of elements */
  | {
    readonly _tag: "Array"
    readonly length: number
    readonly value: string | undefined
  }

/**
 * Creates a `Value` node representing a terminal string leaf.
 *
 * **When to use**
 *
 * Use when building nodes inside a custom `ConfigProvider`'s `get`
 * callback.
 *
 * **Details**
 *
 * The function returns a new plain object.
 *
 * **Example** (Creating a value node)
 *
 * ```ts
 * import { ConfigProvider } from "effect"
 *
 * const node = ConfigProvider.makeValue("3000")
 * // { _tag: "Value", value: "3000" }
 * ```
 *
 * @see {@link makeRecord} – for object-like containers
 * @see {@link makeArray} – for array-like containers
 *
 * @category constructors
 * @since 4.0.0
 */
export function makeValue(value: string): Node {
  return { _tag: "Value", value }
}

/**
 * Creates a `Record` node representing an object-like container with known
 * child keys.
 *
 * **When to use**
 *
 * Use when describing a directory or JSON object inside a custom
 * provider.
 *
 * **Details**
 *
 * The optional `value` allows a node to be both a container and a leaf at the
 * same time (for example, an env var `A=x` that also has children `A_FOO` and
 * `A_BAR`).
 *
 * **Example** (Creating a record node)
 *
 * ```ts
 * import { ConfigProvider } from "effect"
 *
 * const node = ConfigProvider.makeRecord(new Set(["host", "port"]))
 * // { _tag: "Record", keys: Set(["host", "port"]), value: undefined }
 * ```
 *
 * @see {@link makeValue} – for terminal leaves
 * @see {@link makeArray} – for array-like containers
 *
 * @category constructors
 * @since 4.0.0
 */
export function makeRecord(keys: ReadonlySet<string>, value?: string): Node {
  return { _tag: "Record", keys, value }
}

/**
 * Creates an `Array` node representing an indexed container with a known
 * length.
 *
 * **When to use**
 *
 * Use when describing a JSON array or a set of numerically-indexed env
 * vars inside a custom provider.
 *
 * **Details**
 *
 * The optional `value` allows a node to be both a container and a leaf at the
 * same time.
 *
 * **Example** (Creating an array node)
 *
 * ```ts
 * import { ConfigProvider } from "effect"
 *
 * const node = ConfigProvider.makeArray(3)
 * // { _tag: "Array", length: 3, value: undefined }
 * ```
 *
 * @see {@link makeValue} – for terminal leaves
 * @see {@link makeRecord} – for object-like containers
 *
 * @category constructors
 * @since 4.0.0
 */
export function makeArray(length: number, value?: string): Node {
  return { _tag: "Array", length, value }
}

/**
 * Typed error indicating that a configuration source could not be read.
 *
 * **When to use**
 *
 * Use when you use this from a custom provider's `get` callback when the underlying store
 * is unreachable or produces an I/O error, or match on it in error channels
 * when consuming provider output directly.
 *
 * **Gotchas**
 *
 * Do not use `SourceError` for "key not found". That case is represented by
 * returning `undefined` from `load` or `get`.
 *
 * **Example** (Failing with a SourceError)
 *
 * ```ts
 * import { ConfigProvider, Effect } from "effect"
 *
 * const provider = ConfigProvider.make((_path) =>
 *   Effect.fail(
 *     new ConfigProvider.SourceError({ message: "connection refused" })
 *   )
 * )
 * ```
 *
 * @see {@link ConfigProvider} – the interface whose `load`/`get` may fail
 *   with this error
 *
 * @category models
 * @since 4.0.0
 */
export class SourceError extends Data.TaggedError("SourceError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * An ordered sequence of string or numeric segments that addresses a node in
 * the configuration tree. String segments name object keys; numeric segments
 * index into arrays.
 *
 * **When to use**
 *
 * Use to address raw configuration nodes when implementing or transforming a
 * `ConfigProvider`.
 *
 * **Example** (A typical config path)
 *
 * ```ts
 * import type { ConfigProvider } from "effect"
 *
 * const path: ConfigProvider.Path = ["database", "replicas", 0, "host"]
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export type Path = ReadonlyArray<string | number>

/**
 * The core interface for loading raw configuration data.
 *
 * **When to use**
 *
 * Use to type-annotate variables that hold a provider or to implement a
 * custom provider via {@link make}.
 *
 * **Details**
 *
 * `load(path)` resolves `mapInput` and `prefix` transformations, then
 * delegates to `get`. This is what the `Config` module calls. `get(path)` is
 * raw access to the underlying store without path transformations.
 * `mapInput` and `prefix` are optional path transformations set by
 * {@link mapInput} and {@link nested}. All methods return
 * `Effect<Node | undefined, SourceError>`: `undefined` means "not found" and
 * `SourceError` means the source itself failed.
 *
 * @see {@link make} – construct a provider from a lookup function
 * @see {@link orElse} – compose providers with fallback
 *
 * @category models
 * @since 2.0.0
 */
export interface ConfigProvider extends Pipeable {
  /**
   * Returns the node found at `path`, or `undefined` if it does not exist.
   * Fails with `SourceError` when the underlying source cannot be read.
   *
   * **When to use**
   *
   * Use to resolve a path through this provider's path transformations before
   * reading the backing source.
   */
  readonly load: (path: Path) => Effect.Effect<Node | undefined, SourceError>

  /**
   * Raw access to the underlying source.
   *
   * **When to use**
   *
   * Use to read from the backing source without applying this provider's path
   * transformations.
   */
  readonly get: (path: Path) => Effect.Effect<Node | undefined, SourceError>

  /**
   * Function to map the input path.
   *
   * **When to use**
   *
   * Use to store the path transformation applied before raw provider lookup.
   */
  readonly mapInput: ((path: Path) => Path) | undefined

  /**
   * Prefix to add to the input path.
   *
   * **When to use**
   *
   * Use to store the path prefix applied before raw provider lookup.
   */
  readonly prefix: Path | undefined
}

/**
 * Context reference for the active raw configuration provider, registered in the context with a
 * default value of `fromEnv()`. Because it is a `Context.Reference`, it is
 * available without explicit provision; `Config` schemas automatically resolve
 * it.
 *
 * **When to use**
 *
 * Use to override the provider for an entire program via
 * `Effect.provideService(ConfigProvider.ConfigProvider, myProvider)`, or to
 * retrieve the current provider inside an Effect with
 * `yield* ConfigProvider.ConfigProvider`.
 *
 * **Example** (Providing a custom provider)
 *
 * ```ts
 * import { ConfigProvider, Effect } from "effect"
 *
 * const provider = ConfigProvider.fromUnknown({ port: 8080 })
 *
 * const program = Effect.gen(function*() {
 *   const current = yield* ConfigProvider.ConfigProvider
 *   return current
 * }).pipe(
 *   Effect.provideService(ConfigProvider.ConfigProvider, provider)
 * )
 * ```
 *
 * @see {@link layer} – install a provider as a Layer
 * @see {@link layerAdd} – add a fallback provider as a Layer
 *
 * @category services
 * @since 2.0.0
 */
export const ConfigProvider: Context.Reference<ConfigProvider> = Context.Reference<ConfigProvider>(
  "effect/ConfigProvider",
  { defaultValue: () => fromEnv() }
)

const Proto = {
  ...PipeInspectableProto,
  toJSON(this: ConfigProvider) {
    return {
      _id: "ConfigProvider"
    }
  }
}

/**
 * Creates a `ConfigProvider` from a raw lookup function.
 *
 * **When to use**
 *
 * Use when implementing a provider backed by a custom store, such as a
 * database, remote API, or in-memory map.
 *
 * **Details**
 *
 * The `get` callback receives a `Path` and must return
 * `Effect<Node | undefined, SourceError>`. Return `undefined` when the path
 * does not exist; fail with `SourceError` only for actual I/O errors.
 *
 * The optional `mapInput` and `prefix` parameters are wired into the
 * resulting `load` method so that combinators like {@link mapInput} and
 * {@link nested} can compose without wrapping `get`.
 *
 * **Example** (A simple in-memory provider)
 *
 * ```ts
 * import { ConfigProvider, Effect } from "effect"
 *
 * const data: Record<string, string> = {
 *   host: "localhost",
 *   port: "5432"
 * }
 *
 * const provider = ConfigProvider.make((path) => {
 *   const key = path.join(".")
 *   const value = data[key]
 *   return Effect.succeed(
 *     value !== undefined ? ConfigProvider.makeValue(value) : undefined
 *   )
 * })
 * ```
 *
 * @see {@link fromEnv} – pre-built provider for environment variables
 * @see {@link fromUnknown} – pre-built provider for JSON objects
 *
 * @category constructors
 * @since 2.0.0
 */
export function make(
  get: (path: Path) => Effect.Effect<Node | undefined, SourceError>,
  mapInput?: (path: Path) => Path,
  prefix?: Path
): ConfigProvider {
  const self = Object.create(Proto)
  self.get = get
  self.mapInput = mapInput
  self.prefix = prefix
  self.load = (path: Path) => {
    if (mapInput) path = mapInput(path)
    if (prefix) path = [...prefix, ...path]
    return get(path)
  }
  return self
}

/**
 * Returns a provider that falls back to `that` when `self` returns `undefined`
 * for a path.
 *
 * **When to use**
 *
 * Use to layer multiple config sources, such as env vars plus a defaults
 * file, or to provide partial overrides on top of a base config.
 *
 * **Details**
 *
 * Supports both data-last and data-first calling conventions.
 *
 * **Gotchas**
 *
 * The fallback only runs when the path is not found (`undefined`). A
 * `SourceError` from `self` is not caught; it propagates immediately.
 *
 * **Example** (Falling back to a default provider)
 *
 * ```ts
 * import { ConfigProvider } from "effect"
 *
 * const envProvider = ConfigProvider.fromEnv({
 *   env: { HOST: "prod.example.com" }
 * })
 * const defaults = ConfigProvider.fromUnknown({ HOST: "localhost", PORT: "3000" })
 *
 * const combined = ConfigProvider.orElse(envProvider, defaults)
 * ```
 *
 * @see {@link layerAdd} – install a fallback provider via a Layer
 *
 * @category combinators
 * @since 2.0.0
 */
export const orElse: {
  (that: ConfigProvider): (self: ConfigProvider) => ConfigProvider
  (self: ConfigProvider, that: ConfigProvider): ConfigProvider
} = dual(
  2,
  (self: ConfigProvider, that: ConfigProvider): ConfigProvider =>
    make((path) => Effect.flatMap(self.get(path), (node) => node ? Effect.succeed(node) : that.get(path)))
)

/**
 * Transforms the path segments before they reach the underlying store.
 *
 * **When to use**
 *
 * Use when you use this for renaming or re-casing path segments, or for adding suffixes and
 * other per-segment transformations. See {@link constantCase} for a common
 * specialization.
 *
 * **Details**
 *
 * The function `f` receives the full path and must return a new path. If the
 * provider already has a `mapInput`, the functions compose: the existing
 * mapping runs first, then `f`. Supports both data-last and data-first calling
 * conventions.
 *
 * **Example** (Uppercasing path segments)
 *
 * ```ts
 * import { ConfigProvider } from "effect"
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: { APP_HOST: "localhost" }
 * })
 *
 * const upper = ConfigProvider.mapInput(provider, (path) =>
 *   path.map((seg) =>
 *     typeof seg === "string" ? seg.toUpperCase() : seg
 *   )
 * )
 * ```
 *
 * @see {@link constantCase} – a preset that converts to `CONSTANT_CASE`
 * @see {@link nested} – for prepending a prefix instead of transforming
 *
 * @category combinators
 * @since 4.0.0
 */
export const mapInput: {
  (f: (path: Path) => Path): (self: ConfigProvider) => ConfigProvider
  (self: ConfigProvider, f: (path: Path) => Path): ConfigProvider
} = dual(
  2,
  (self: ConfigProvider, f: (path: Path) => Path): ConfigProvider => {
    return make(self.get, self.mapInput ? flow(self.mapInput, f) : f, self.prefix ? f(self.prefix) : undefined)
  }
)

/**
 * Converts all string path segments to `CONSTANT_CASE` before lookup.
 *
 * **When to use**
 *
 * Use to bridge camelCase schema keys to `SCREAMING_SNAKE_CASE`
 * environment variables.
 *
 * **Details**
 *
 * Numeric segments are left unchanged. This is a specialization of
 * {@link mapInput}.
 *
 * **Example** (Resolving camelCase keys to env vars)
 *
 * ```ts
 * import { ConfigProvider } from "effect"
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: { DATABASE_HOST: "localhost" }
 * }).pipe(ConfigProvider.constantCase)
 *
 * // path ["databaseHost"] now resolves to env var DATABASE_HOST
 * ```
 *
 * @see {@link mapInput} – for arbitrary path transformations
 *
 * @category combinators
 * @since 2.0.0
 */
export const constantCase: (self: ConfigProvider) => ConfigProvider = mapInput((path) =>
  path.map((seg) => typeof seg === "number" ? seg : Str.constantCase(seg))
)

/**
 * Scopes a provider so that all lookups are prefixed with the given path
 * segments.
 *
 * **When to use**
 *
 * Use to namespace config under a prefix like `"app"` or `"database"`, or
 * to reuse the same provider shape for multiple sub-configs.
 *
 * **Details**
 *
 * Accepts a single string or a full `Path` array. Supports both data-last and
 * data-first calling conventions.
 *
 * **Gotchas**
 *
 * The prefix is prepended after any `mapInput` transformation runs, so
 * ordering matters when composing with {@link mapInput} or
 * {@link constantCase}.
 *
 * **Example** (Nesting under a prefix)
 *
 * ```ts
 * import { ConfigProvider } from "effect"
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: { APP_HOST: "localhost", APP_PORT: "3000" }
 * })
 *
 * // Lookups for ["HOST"] now resolve to ["APP", "HOST"]
 * const scoped = ConfigProvider.nested(provider, "APP")
 * ```
 *
 * @see {@link mapInput} – for arbitrary path transformations
 *
 * @category combinators
 * @since 2.0.0
 */
export const nested: {
  (prefix: string | Path): (self: ConfigProvider) => ConfigProvider
  (self: ConfigProvider, prefix: string | Path): ConfigProvider
} = dual(
  2,
  (self: ConfigProvider, prefix: string | Path): ConfigProvider => {
    const path = typeof prefix === "string" ? [prefix] : prefix
    return make(self.get, self.mapInput, self.prefix ? [...self.prefix, ...path] : path)
  }
)

/**
 * Provides a layer that installs a `ConfigProvider` as the active provider for
 * all downstream effects, replacing any previously installed provider.
 *
 * **When to use**
 *
 * Use to set the config source for an entire application or test suite.
 *
 * **Details**
 *
 * Accepts either a plain `ConfigProvider` or an `Effect` that produces one.
 * When given an Effect, it is evaluated once when the layer is built.
 *
 * **Example** (Using a JSON object as the config source)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect, Layer } from "effect"
 *
 * const TestLayer = ConfigProvider.layer(
 *   ConfigProvider.fromUnknown({ port: 8080 })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const port = yield* Config.number("port")
 *   return port
 * })
 *
 * // Effect.runSync(Effect.provide(program, TestLayer)) // 8080
 * ```
 *
 * @see {@link layerAdd} – add a provider without replacing the existing one
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <E = never, R = never>(
  self: ConfigProvider | Effect.Effect<ConfigProvider, E, R>
): Layer.Layer<never, E, Exclude<R, Scope>> =>
  Effect.isEffect(self) ? Layer.effect(ConfigProvider)(self) : Layer.succeed(ConfigProvider)(self)

/**
 * Creates a Layer that composes a new `ConfigProvider` with the currently
 * active one, rather than replacing it.
 *
 * **When to use**
 *
 * Use to add defaults that should only apply when the primary provider
 * has no value for a path, or to override specific keys while keeping the rest
 * from the existing provider by setting `asPrimary: true`.
 *
 * **Details**
 *
 * By default, the new provider acts as a fallback and is consulted only when
 * the current provider returns `undefined`. Set `asPrimary: true` to make the
 * new provider the primary source, with the existing one as fallback.
 *
 * **Example** (Adding default values)
 *
 * ```ts
 * import { ConfigProvider } from "effect"
 *
 * const defaults = ConfigProvider.fromUnknown({
 *   HOST: "localhost",
 *   PORT: "3000"
 * })
 *
 * // The current env provider is tried first; `defaults` is the fallback
 * const DefaultsLayer = ConfigProvider.layerAdd(defaults)
 * ```
 *
 * @see {@link layer} – replace the provider entirely
 * @see {@link orElse} – compose providers without layers
 *
 * @category layers
 * @since 4.0.0
 */
export const layerAdd = <E = never, R = never>(
  self: ConfigProvider | Effect.Effect<ConfigProvider, E, R>,
  options?: {
    readonly asPrimary?: boolean | undefined
  } | undefined
): Layer.Layer<never, E, Exclude<R, Scope>> =>
  Layer.effect(ConfigProvider)(
    Effect.gen(function*() {
      const current = yield* ConfigProvider
      const configProvider = Effect.isEffect(self) ? yield* self : self
      return options?.asPrimary ? orElse(configProvider, current) : orElse(current, configProvider)
    })
  )

/**
 * Creates a `ConfigProvider` backed by an in-memory JavaScript value
 * (typically a parsed JSON object).
 *
 * **When to use**
 *
 * Use when you use this in unit or integration tests where you want deterministic config
 * without touching the environment, or when embedding config directly in code
 * or reading a JSON file.
 *
 * **Details**
 *
 * Path traversal follows standard JS rules: string segments index into object
 * keys, numeric segments index into arrays. Returns `undefined` for any path
 * that cannot be resolved. Never fails with `SourceError`.
 *
 * Primitive values (`number`, `boolean`, `bigint`) are stringified via
 * `String(...)`.
 *
 * **Example** (Providing config from a plain object)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const provider = ConfigProvider.fromUnknown({
 *   database: {
 *     host: "localhost",
 *     port: 5432
 *   }
 * })
 *
 * const host = Config.string("host").parse(
 *   provider.pipe(ConfigProvider.nested("database"))
 * )
 *
 * // Effect.runSync(host) // "localhost"
 * ```
 *
 * @see {@link fromEnv} – for environment variables
 * @see {@link make} – for custom backing stores
 *
 * @category ConfigProviders
 * @since 4.0.0
 */
export function fromUnknown(root: unknown): ConfigProvider {
  return make((path) => Effect.succeed(nodeAtJson(root, path)))
}

function nodeAtJson(root: unknown, path: Path): Node | undefined {
  let cur: unknown = root

  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined

    if (Array.isArray(cur)) {
      if (typeof seg !== "number" || !Number.isInteger(seg) || seg < 0 || seg >= cur.length) return undefined
      cur = cur[seg]
      continue
    }

    if (Predicate.isObject(cur)) {
      if (typeof seg !== "string") return undefined
      if (!Object.hasOwn(cur, seg)) return undefined
      cur = cur[seg]
      continue
    }

    // cannot descend
    return undefined
  }

  return describeUnknown(cur)
}

function describeUnknown(u: unknown): Node | undefined {
  if (u === undefined || u === null) return undefined
  if (typeof u === "string") return makeValue(u)
  if (typeof u === "number" || typeof u === "boolean" || typeof u === "bigint") {
    return makeValue(String(u))
  }
  if (Array.isArray(u)) return makeArray(u.length)
  if (Predicate.isObject(u)) {
    return makeRecord(new Set(Object.keys(u)))
  }
  // unknown values
  return makeValue(format(u))
}

/**
 * Creates a `ConfigProvider` backed by environment variables.
 *
 * **When to use**
 *
 * Use to read configuration from `process.env`, which is the default when
 * no provider is explicitly set, or to pass a custom env record for testing or
 * non-Node runtimes.
 *
 * **Details**
 *
 * Path segments are joined with `_` for direct lookup, and env var names are
 * also split on `_` to build a trie for child key discovery. This means
 * `DATABASE_HOST=localhost` is accessible at both path `["DATABASE_HOST"]`
 * and `["DATABASE", "HOST"]`. If all immediate children of a trie node have
 * purely numeric names, the node is reported as an `Array`; otherwise as a
 * `Record`.
 *
 * The default environment merges `process.env` and `import.meta.env` (when
 * available). Override by passing `{ env: { ... } }`.
 *
 * Never fails with `SourceError` — all lookups are synchronous.
 *
 * **Example** (Reading from a custom env record)
 *
 * ```ts
 * import { Config, ConfigProvider, Effect } from "effect"
 *
 * const provider = ConfigProvider.fromEnv({
 *   env: {
 *     DATABASE_HOST: "localhost",
 *     DATABASE_PORT: "5432"
 *   }
 * })
 *
 * const host = Config.string("HOST").parse(
 *   provider.pipe(ConfigProvider.nested("DATABASE"))
 * )
 *
 * // Effect.runSync(host) // "localhost"
 * ```
 *
 * @see {@link fromUnknown} – for JSON objects
 * @see {@link constantCase} – bridge camelCase keys to SCREAMING_SNAKE_CASE
 *
 * @category ConfigProviders
 * @since 2.0.0
 */
export function fromEnv(options?: { readonly env?: Record<string, string> | undefined }): ConfigProvider {
  const env = options?.env ?? {
    ...globalThis?.process?.env,
    ...(import.meta as any)?.env
  }

  const trie = buildEnvTrie(env)

  return make((path) => Effect.succeed(nodeAtEnv(trie, env, path)))
}

type EnvTrieNode = {
  value?: string
  children?: Record<string, EnvTrieNode>
}

function buildEnvTrie(env: Record<string, string | undefined>): EnvTrieNode {
  const root: EnvTrieNode = {}

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue

    // Split on "_" and keep empty segments (no special handling for "__")
    const segments = name.split("_")

    let node = root
    for (const seg of segments) {
      node.children ??= {}
      node = node.children[seg] ??= {}
    }

    // co-located value at this node
    node.value = value
  }

  return root
}

const NUMERIC_INDEX = /^(0|[1-9][0-9]*)$/

function nodeAtEnv(trie: EnvTrieNode, env: Record<string, string | undefined>, path: Path): Node | undefined {
  const key = path.map(String).join("_")
  const leafValue = env[key]

  const trieNode = trieNodeAt(trie, path)
  const children = trieNode?.children ? Object.keys(trieNode.children) : []

  if (children.length === 0) {
    return leafValue === undefined ? undefined : makeValue(leafValue)
  }

  const allNumeric = children.every((k) => NUMERIC_INDEX.test(k))
  if (allNumeric) {
    const length = Math.max(...children.map((k) => parseInt(k, 10))) + 1
    return makeArray(length, leafValue)
  }

  return makeRecord(new Set(children), leafValue)
}

function trieNodeAt(root: EnvTrieNode, path: Path): EnvTrieNode | undefined {
  if (path.length === 0) return root

  // Convert path segments to strings and navigate through the trie
  let node: EnvTrieNode | undefined = root
  for (const seg of path) {
    node = node?.children?.[String(seg)]
    if (!node) return undefined
  }
  return node
}

/**
 * Creates a `ConfigProvider` by parsing the string contents of a `.env` file.
 *
 * **When to use**
 *
 * Use when you already have the `.env` contents as a string, such as
 * contents fetched from a remote store or embedded in a test. Use
 * {@link fromDotEnv} instead if you want to read a `.env` file from disk.
 *
 * **Details**
 *
 * Supports `export` prefixes, single/double/backtick quoting, inline comments,
 * and escaped newlines. Variable expansion (for example, `${VAR}`) is disabled
 * by default; enable with `{ expandVariables: true }`.
 *
 * Parsing is based on the `dotenv` / `dotenv-expand` algorithm.
 *
 * Internally delegates to {@link fromEnv} with the parsed key-value pairs.
 *
 * **Example** (Parsing .env contents)
 *
 * ```ts
 * import { ConfigProvider } from "effect"
 *
 * const contents = `
 * HOST=localhost
 * PORT=3000
 * # this is a comment
 * `
 *
 * const provider = ConfigProvider.fromDotEnvContents(contents)
 * ```
 *
 * @see {@link fromDotEnv} – loads a `.env` file from disk
 * @see {@link fromEnv} – for raw environment variable access
 *
 * @category ConfigProviders
 * @since 4.0.0
 */
export function fromDotEnvContents(lines: string, options?: {
  readonly expandVariables?: boolean | undefined
}): ConfigProvider {
  let env = parseDotEnvContents(lines)
  if (options?.expandVariables) {
    env = dotEnvExpand(env)
  }
  return fromEnv({ env })
}

const DOT_ENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg

function parseDotEnvContents(lines: string): Record<string, string> {
  const obj: Record<string, string> = {}

  // Convert line breaks to same format
  lines = lines.replace(/\r\n?/gm, "\n")

  let match: RegExpExecArray | null
  while ((match = DOT_ENV_LINE.exec(lines)) != null) {
    const key = match[1]

    // Default undefined or null to empty string
    let value = match[2] || ""

    // Remove whitespace
    value = value.trim()

    // Check if double quoted
    const maybeQuote = value[0]

    // Remove surrounding quotes
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2")

    // Expand newlines if double quoted
    if (maybeQuote === "\"") {
      value = value.replace(/\\n/g, "\n")
      value = value.replace(/\\r/g, "\r")
    }

    // Add to object
    obj[key] = value
  }

  return obj
}

function dotEnvExpand(parsed: Record<string, string>): Record<string, string> {
  const newParsed: Record<string, string> = {}

  for (const configKey in parsed) {
    // resolve escape sequences
    newParsed[configKey] = interpolate(parsed[configKey], parsed).replace(/\\\$/g, "$")
  }

  return newParsed
}

function interpolate(envValue: string, parsed: Record<string, string>): string {
  // find the last unescaped dollar sign in the
  // value so that we can evaluate it
  const lastUnescapedDollarSignIndex = searchLast(envValue, /(?!(?<=\\))\$/g)

  // If we couldn't match any unescaped dollar sign
  // let's return the string as is
  if (lastUnescapedDollarSignIndex === -1) return envValue

  // This is the right-most group of variables in the string
  const rightMostGroup = envValue.slice(lastUnescapedDollarSignIndex)

  /**
   * This finds the inner most variable/group divided
   * by variable name and default value (if present)
   * (
   *   (?!(?<=\\))\$        // only match dollar signs that are not escaped
   *   {?                   // optional opening curly brace
   *     ([\w]+)            // match the variable name
   *     (?::-([^}\\]*))?   // match an optional default value
   *   }?                   // optional closing curly brace
   * )
   */
  const matchGroup = /((?!(?<=\\))\${?([\w]+)(?::-([^}\\]*))?}?)/
  const match = rightMostGroup.match(matchGroup)

  if (match !== null) {
    const [_, group, variableName, defaultValue] = match

    return interpolate(
      envValue.replace(group, defaultValue || parsed[variableName] || ""),
      parsed
    )
  }

  return envValue
}

function searchLast(str: string, rgx: RegExp): number {
  const matches = Array.from(str.matchAll(rgx))
  return matches.length > 0 ? matches.slice(-1)[0].index : -1
}

/**
 * Creates a `ConfigProvider` by reading and parsing a `.env` file from the
 * file system.
 *
 * **When to use**
 *
 * Use to load environment config from a `.env` file at application
 * startup. Use {@link fromDotEnvContents} if you already have the file
 * contents as a string.
 *
 * **Details**
 *
 * Requires `FileSystem` in the Effect context. Defaults to reading `".env"` in
 * the current directory; override with `{ path: "/custom/.env" }`.
 *
 * Returns an `Effect` that resolves to a `ConfigProvider`. Fails with a
 * `PlatformError` if the file cannot be read.
 *
 * **Example** (Loading a .env file)
 *
 * ```ts
 * import { ConfigProvider, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const provider = yield* ConfigProvider.fromDotEnv()
 *   return provider
 * })
 * ```
 *
 * @see {@link fromDotEnvContents} – parse a `.env` string directly
 * @see {@link fromEnv} – read from the runtime environment
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromDotEnv: (options?: {
  readonly path?: string | undefined
  readonly expandVariables?: boolean | undefined
}) => Effect.Effect<ConfigProvider, PlatformError, FileSystem.FileSystem> = Effect.fnUntraced(
  function*(options) {
    const fs = yield* FileSystem.FileSystem
    const content = yield* fs.readFileString(options?.path ?? ".env")
    return fromEnv({ env: parseDotEnvContents(content) })
  }
)

/**
 * Creates a `ConfigProvider` that reads configuration from a directory tree
 * on disk, where each file is a leaf value and each directory is a container.
 *
 * **When to use**
 *
 * Use when you use this for Kubernetes ConfigMap or Secret volume mounts, where each key is
 * a file under a mount path, or for any file-per-key configuration layout.
 *
 * **Details**
 *
 * Resolution tries a regular file first and returns a `Value` node with
 * trimmed file contents. If the file read fails, it tries a directory and
 * returns a `Record` node with immediate child names as keys. If both fail, it
 * returns `SourceError`.
 *
 * Requires `Path` and `FileSystem` in the Effect context. Defaults to root
 * path `/`; override with `{ rootPath: "/etc/config" }`.
 *
 * **Example** (Reading config from a directory)
 *
 * ```ts
 * import { ConfigProvider, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const provider = yield* ConfigProvider.fromDir({
 *     rootPath: "/etc/myapp"
 *   })
 *   return provider
 * })
 * ```
 *
 * @see {@link fromEnv} – for environment variables
 * @see {@link fromDotEnv} – for `.env` files
 *
 * @category ConfigProviders
 * @since 4.0.0
 */
export const fromDir: (options?: {
  readonly rootPath?: string | undefined
}) => Effect.Effect<
  ConfigProvider,
  never,
  Path_.Path | FileSystem.FileSystem
> = Effect.fnUntraced(function*(options) {
  const platformPath = yield* Path_.Path
  const fs = yield* FileSystem.FileSystem
  const rootPath = options?.rootPath ?? "/"

  return make((path) => {
    const fullPath = platformPath.join(rootPath, ...path.map(String))

    // Try reading as a *file*
    const asFile = fs.readFileString(fullPath).pipe(
      Effect.map((content) => makeValue(content.trim()))
    )

    // If not a file, try reading as a *directory*
    const asDirectory = fs.readDirectory(fullPath).pipe(
      Effect.map((entries: ReadonlyArray<any>) => {
        // Support both string paths and DirEntry-like objects
        const keys = entries.map((e) => typeof e === "string" ? platformPath.basename(e) : format(e?.name ?? ""))
        return makeRecord(new Set(keys))
      })
    )

    return asFile.pipe(
      Effect.catch(() => asDirectory),
      Effect.mapError((cause: PlatformError) =>
        new SourceError({
          message: `Failed to read file at ${platformPath.join(rootPath, ...path.map(String))}`,
          cause
        })
      )
    )
  })
})
