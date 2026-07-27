/**
 * Stores Effect services in typed maps.
 *
 * A `Context` holds service implementations under `Context.Service` or
 * `Context.Reference` keys, and its type records which keys are present.
 * Effects use contexts as their environment, so services can be provided once
 * instead of passed through every function call. This module includes helpers
 * for creating keys, building contexts, adding and reading services, merging
 * contexts, and selecting or removing services.
 *
 * @since 4.0.0
 */
import type { Effect, EffectIterator } from "./Effect.ts"
import * as Effectable from "./Effectable.ts"
import * as Equal from "./Equal.ts"
import { dual, type LazyArg } from "./Function.ts"
import * as Hash from "./Hash.ts"
import type { Inspectable } from "./Inspectable.ts"
import { exitSucceed, PipeInspectableProto, withFiber } from "./internal/core.ts"
import { getStackTraceLimit, setStackTraceLimit } from "./internal/stackTraceLimit.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type * as Types from "./Types.ts"

/**
 * String literal type used as the runtime type identifier for `Context`
 * service keys.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type ServiceTypeId = "~effect/Context/Service"

/**
 * Runtime type identifier attached to `Context` service keys and used by
 * `isKey` to recognize them.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const ServiceTypeId: ServiceTypeId = "~effect/Context/Service"

/**
 * Typed identifier for a service stored in a `Context`.
 *
 * **When to use**
 *
 * Use as the typed handle for storing, retrieving, and requiring a specific
 * service in a `Context`.
 *
 * **Details**
 *
 * `Identifier` tracks the requirement in Effect types, while `Shape` is the
 * service implementation retrieved by the key. A key is also an Effect value,
 * so yielding it inside `Effect.gen` retrieves the service from the current
 * fiber context.
 *
 * @see {@link Service} for creating required service keys
 * @see {@link Reference} for creating service keys with default values
 *
 * @category models
 * @since 4.0.0
 */
export interface Key<out Identifier, out Shape> extends Effect<Shape, never, Identifier> {
  readonly [ServiceTypeId]: ServiceTypeId
  readonly Service: Shape
  readonly Identifier: Identifier
  readonly key: string
  readonly stack?: string | undefined
}

/**
 * Context key with helper methods for working with a service.
 *
 * **Details**
 *
 * `context` creates a one-service `Context`, `use` and `useSync` retrieve the
 * service from the current Effect context before applying a function, and `of`
 * is a type-level helper for service values.
 *
 * **Example** (Defining a service key)
 *
 * ```ts
 * import { Context } from "effect"
 *
 * // Define an identifier for a database service
 * const Database = Context.Service<{ query: (sql: string) => string }>(
 *   "Database"
 * )
 *
 * // The key can be used to store and retrieve services
 * const context = Context.make(Database, { query: (sql) => `Result: ${sql}` })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface Service<in out Identifier, in out Shape> extends Key<Identifier, Shape> {
  of(this: void, self: Shape): Shape
  context(self: Shape): Context<Identifier>
  use<A, E, R>(f: (service: Shape) => Effect<A, E, R>): Effect<A, E, R | Identifier>
  useSync<A>(f: (service: Shape) => A): Effect<A, never, Identifier>
}

/**
 * Class-style service key produced by `Context.Service<Self, Shape>()("Id")`.
 *
 * **When to use**
 *
 * Use when declaring a service as a class so the class value can serve as the
 * `Context` key.
 *
 * **Details**
 *
 * The class itself is the `Context` key, and its string `key` identifies the
 * service at runtime.
 *
 * @see {@link Service} for creating function-style keys or class-style service keys
 *
 * @category models
 * @since 4.0.0
 */
export interface ServiceClass<in out Self, in out Identifier extends string, in out Shape>
  extends Service<Self, Shape>
{
  new(_: never): ServiceClass.Shape<Identifier, Shape>
  readonly key: Identifier
}

/**
 * Namespace containing helper types for class-style `Context.Service`
 * declarations.
 *
 * @since 4.0.0
 */
export declare namespace ServiceClass {
  /**
   * Runtime and type-level metadata carried by a class-style service key,
   * including its service type identifier, string key, and service shape.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Shape<Identifier extends string, Service> {
    readonly [ServiceTypeId]: typeof ServiceTypeId
    readonly key: Identifier
    readonly Service: Service
  }
}

/**
 * Creates a `Context` service key.
 *
 * **When to use**
 *
 * Use when you need to define a context service key for a dependency that must
 * be provided by the surrounding context.
 *
 * **Details**
 *
 * Call `Context.Service("Key")` for a function-style key, or use the two-stage
 * form `Context.Service<Self, Shape>()("Key")` for class-style service
 * declarations. The returned key can be yielded as an Effect and passed to
 * `Context.make`, `Context.add`, and the Context getter functions.
 *
 * **Gotchas**
 *
 * The string key is the runtime identity of the service. Reusing the same key
 * string for unrelated services makes them occupy the same slot in a
 * `Context`.
 *
 * **Example** (Creating service keys)
 *
 * ```ts
 * import { Context } from "effect"
 *
 * // Create a simple service
 * const Database = Context.Service<{
 *   query: (sql: string) => string
 * }>("Database")
 *
 * // Create a service class
 * class Config extends Context.Service<Config, {
 *   port: number
 * }>()("Config") {}
 *
 * // Use the services to create contexts
 * const db = Context.make(Database, {
 *   query: (sql) => `Result: ${sql}`
 * })
 * const config = Context.make(Config, { port: 8080 })
 * ```
 *
 * @see {@link Reference} for service keys with default values
 *
 * @category constructors
 * @since 4.0.0
 */
export const Service: {
  <Identifier, Shape = Identifier>(key: string): Service<Identifier, Shape>
  <Self, Shape>(): <
    const Identifier extends string,
    E,
    R = Types.unassigned,
    Args extends ReadonlyArray<any> = never
  >(
    id: Identifier,
    options?: {
      readonly make: ((...args: Args) => Effect<Shape, E, R>) | Effect<Shape, E, R> | undefined
    } | undefined
  ) =>
    & ServiceClass<Self, Identifier, Shape>
    & ([Types.unassigned] extends [R] ? unknown
      : { readonly make: [Args] extends [never] ? Effect<Shape, E, R> : (...args: Args) => Effect<Shape, E, R> })
  <Self>(): <
    const Identifier extends string,
    Make extends Effect<any, any, any> | ((...args: any) => Effect<any, any, any>)
  >(
    id: Identifier,
    options: {
      readonly make: Make
    }
  ) =>
    & ServiceClass<
      Self,
      Identifier,
      Make extends
        Effect<infer _A, infer _E, infer _R> | ((...args: infer _Args) => Effect<infer _A, infer _E, infer _R>) ? _A
        : never
    >
    & { readonly make: Make }
} = function() {
  const prevLimit = getStackTraceLimit()
  setStackTraceLimit(2)
  const err = new Error()
  setStackTraceLimit(prevLimit)
  function KeyClass() {}
  const self = KeyClass as any as Types.Mutable<Reference<any>>
  Object.setPrototypeOf(self, ServiceProto)
  // @effect-diagnostics-next-line floatingEffect:off
  Object.defineProperty(self, "stack", {
    get() {
      return err.stack
    }
  })
  if (arguments.length > 0) {
    self.key = arguments[0]
    if (arguments[1]?.defaultValue) {
      self[ReferenceTypeId] = ReferenceTypeId
      self.defaultValue = arguments[1].defaultValue
    }
    return self
  }
  return function(key: string, options?: {
    readonly make?: any
  }) {
    self.key = key
    if (options?.make) {
      ;(self as any).make = options.make
    }
    return self
  }
} as any

const ServiceProto: any = {
  [ServiceTypeId]: ServiceTypeId,
  ...Effectable.Prototype<Service<never, any>>({
    label: "Service",
    evaluate(fiber) {
      return exitSucceed(get(fiber.context, this))
    }
  }),
  toJSON<I, A>(this: Service<I, A>) {
    return {
      _id: "Service",
      key: this.key,
      stack: this.stack
    }
  },
  of<Service>(this: void, self: Service): Service {
    return self
  },
  context<Identifier, Shape>(
    this: Service<Identifier, Shape>,
    self: Shape
  ): Context<Identifier> {
    return make(this, self)
  },
  use<A, E, R>(this: Service<never, any>, f: (service: any) => Effect<A, E, R>): Effect<A, E, R> {
    return withFiber((fiber) => f(get(fiber.context, this)))
  },
  useSync<A>(this: Service<never, any>, f: (service: any) => A): Effect<A, never, never> {
    return withFiber((fiber) => exitSucceed(f(get(fiber.context, this))))
  }
}

const ReferenceTypeId = "~effect/Context/Reference" as const

/**
 * Service key with a lazily computed default value.
 *
 * **Details**
 *
 * When a `Reference` is requested from a `Context` that does not contain an
 * override, Context getters that resolve references return the cached default
 * value instead of failing.
 *
 * **Example** (Defining a reference with a default value)
 *
 * ```ts
 * import { Context } from "effect"
 *
 * // Define a reference with a default value
 * const LoggerRef: Context.Reference<{ log: (msg: string) => void }> =
 *   Context.Reference("Logger", {
 *     defaultValue: () => ({ log: (msg: string) => console.log(msg) })
 *   })
 *
 * // The reference can be used without explicit provision
 * const context = Context.empty()
 * const logger = Context.get(context, LoggerRef) // Uses default value
 * ```
 *
 * @category models
 * @since 3.11.0
 */
export interface Reference<in out Shape> extends Service<never, Shape> {
  readonly [ReferenceTypeId]: typeof ReferenceTypeId
  readonly defaultValue: () => Shape
  [Symbol.iterator](): EffectIterator<Reference<Shape>>
  new(_: never): {}
}

/**
 * Namespace containing utility types for `Context` service keys.
 *
 * **Example** (Extracting service types)
 *
 * ```ts
 * import { Context } from "effect"
 *
 * const Database = Context.Service<{
 *   query: (sql: string) => string
 * }>("Database")
 *
 * // Extract service type from a key
 * type DatabaseService = Context.Service.Shape<typeof Database>
 *
 * // Extract identifier type from a key
 * type DatabaseId = Context.Service.Identifier<typeof Database>
 * ```
 *
 * @since 2.0.0
 */
export declare namespace Service {
  /**
   * Type that matches any `Context` service key regardless of its identifier or
   * service shape.
   *
   * **Example** (Typing any service key)
   *
   * ```ts
   * import { Context } from "effect"
   *
   * // Any represents any possible service type
   * const services: Array<Context.Service.Any> = [
   *   Context.Service<{ log: (msg: string) => void }>("Logger"),
   *   Context.Service<{ query: (sql: string) => string }>("Database")
   * ]
   * ```
   *
   * @category models
   * @since 4.0.0
   */
  export type Any = Key<never, any> | Key<any, any>

  /**
   * Extracts the service implementation type stored behind a `Context` service
   * key.
   *
   * **Example** (Extracting a service shape)
   *
   * ```ts
   * import { Context } from "effect"
   *
   * const Database = Context.Service<{ query: (sql: string) => string }>(
   *   "Database"
   * )
   *
   * // Extract the service shape from the service
   * type DatabaseService = Context.Service.Shape<typeof Database>
   * // DatabaseService is { query: (sql: string) => string }
   * ```
   *
   * @category models
   * @since 4.0.0
   */
  export type Shape<T> = T extends Key<infer _I, infer S> ? S : never

  /**
   * Extracts the identifier, or requirement type, associated with a `Context`
   * service key.
   *
   * **Example** (Extracting a service identifier)
   *
   * ```ts
   * import { Context } from "effect"
   *
   * const Database = Context.Service<{ query: (sql: string) => string }>(
   *   "Database"
   * )
   *
   * // Extract the identifier type from a key
   * type DatabaseId = Context.Service.Identifier<typeof Database>
   * // DatabaseId is the identifier type
   * ```
   *
   * @category models
   * @since 2.0.0
   */
  export type Identifier<T> = T extends Key<infer I, infer _S> ? I : never
}

const TypeId = "~effect/Context" as const

/**
 * Immutable collection of service implementations used for dependency
 * injection in Effect programs.
 *
 * **Details**
 *
 * The type parameter tracks the service identifiers available in the context.
 * At runtime, services are stored by each key's string `key`.
 *
 * **Example** (Creating a context with multiple services)
 *
 * ```ts
 * import { Context } from "effect"
 *
 * // Create a context with multiple services
 * const Logger = Context.Service<{ log: (msg: string) => void }>("Logger")
 * const Database = Context.Service<{ query: (sql: string) => string }>(
 *   "Database"
 * )
 *
 * const context = Context.make(Logger, {
 *   log: (msg: string) => console.log(msg)
 * })
 *   .pipe(Context.add(Database, { query: (sql) => `Result: ${sql}` }))
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Context<in Services> extends Equal.Equal, Pipeable, Inspectable {
  readonly [TypeId]: {
    readonly _Services: Types.Contravariant<Services>
  }
  readonly mapUnsafe: ReadonlyMap<string, any>
  mutable: boolean
}

/**
 * Creates a `Context` from an existing service map.
 *
 * **When to use**
 *
 * Use when constructing a low-level `Context` from a trusted map whose lifecycle
 * you control.
 *
 * **Gotchas**
 *
 * This is unsafe because later mutation of the provided map can affect the
 * created `Context`. Prefer `empty`, `make`, `add`, or `merge` for normal
 * Context construction.
 *
 * **Example** (Creating a context from a map)
 *
 * ```ts
 * import { Context } from "effect"
 *
 * // Create a context from a Map (unsafe)
 * const map = new Map([
 *   ["Logger", { log: (msg: string) => console.log(msg) }]
 * ])
 *
 * const context = Context.makeUnsafe(map)
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeUnsafe = <Services = never>(mapUnsafe: ReadonlyMap<string, any>): Context<Services> => {
  const self = Object.create(Proto)
  self.mapUnsafe = mapUnsafe
  self.mutable = false
  return self
}

const Proto: Omit<Context<never>, "mapUnsafe" | "mutable"> = {
  ...PipeInspectableProto,
  [TypeId]: {
    _Services: (_: never) => _
  },
  toJSON(this: Context<never>) {
    return {
      _id: "Context",
      services: Array.from(this.mapUnsafe).map(([key, value]) => ({ key, value }))
    }
  },
  [Equal.symbol]<A>(this: Context<A>, that: unknown): boolean {
    if (
      !isContext(that)
      || this.mapUnsafe.size !== that.mapUnsafe.size
    ) return false
    for (const k of this.mapUnsafe.keys()) {
      if (
        !that.mapUnsafe.has(k) ||
        !Equal.equals(this.mapUnsafe.get(k), that.mapUnsafe.get(k))
      ) {
        return false
      }
    }
    return true
  },
  [Hash.symbol]<A>(this: Context<A>): number {
    return Hash.number(this.mapUnsafe.size)
  }
}

/**
 * Checks whether the provided argument is a `Context`.
 *
 * **When to use**
 *
 * Use to narrow an unknown value before passing it to APIs that require a
 * `Context`.
 *
 * **Details**
 *
 * This checks the runtime `Context` marker and does not inspect which services
 * the context contains.
 *
 * **Gotchas**
 *
 * This guard only proves that the value is a `Context`; it does not prove that
 * any specific service is present.
 *
 * **Example** (Checking for contexts)
 *
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.strictEqual(Context.isContext(Context.empty()), true)
 * ```
 *
 * @see {@link isKey} for checking service keys
 * @see {@link isReference} for checking references with defaults
 *
 * @category guards
 * @since 2.0.0
 */
export const isContext = (u: unknown): u is Context<never> => hasProperty(u, TypeId)

/**
 * Checks whether the provided argument is a `Key`.
 *
 * **Example** (Checking for keys)
 *
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.strictEqual(Context.isKey(Context.Service("Service")), true)
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isKey = (u: unknown): u is Key<any, any> => hasProperty(u, ServiceTypeId)

/**
 * Checks whether the provided argument is a `Reference`.
 *
 * **Example** (Checking for references)
 *
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const LoggerRef = Context.Reference("Logger", {
 *   defaultValue: () => ({ log: (msg: string) => console.log(msg) })
 * })
 *
 * assert.strictEqual(Context.isReference(LoggerRef), true)
 * assert.strictEqual(Context.isReference(Context.Service("Key")), false)
 * ```
 *
 * @category guards
 * @since 3.11.0
 */
export const isReference = (u: unknown): u is Reference<any> => hasProperty(u, ReferenceTypeId)

/**
 * Returns an empty `Context`.
 *
 * **Example** (Creating an empty context)
 *
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.strictEqual(Context.isContext(Context.empty()), true)
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const empty = (): Context<never> => emptyContext
const emptyContext = makeUnsafe(new Map())

/**
 * Creates a new `Context` with a single service associated to the key.
 *
 * **Example** (Creating a context with one service)
 *
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 *
 * const context = Context.make(Port, { PORT: 8080 })
 *
 * assert.deepStrictEqual(Context.get(context, Port), { PORT: 8080 })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const make = <I, S>(
  key: Key<I, S>,
  service: Types.NoInfer<S>
): Context<I> => makeUnsafe(new Map([[key.key, service]]))

/**
 * Adds a service to a given `Context`.
 *
 * **When to use**
 *
 * Use when you need to store a known service value in a `Context`.
 *
 * **Details**
 *
 * If the context already contains the same service key, the new service
 * replaces the previous one.
 *
 * **Example** (Adding a service to a context)
 *
 * ```ts
 * import { Context, pipe } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const someContext = Context.make(Port, { PORT: 8080 })
 *
 * const context = pipe(
 *   someContext,
 *   Context.add(Timeout, { TIMEOUT: 5000 })
 * )
 *
 * assert.deepStrictEqual(Context.get(context, Port), { PORT: 8080 })
 * assert.deepStrictEqual(Context.get(context, Timeout), { TIMEOUT: 5000 })
 * ```
 *
 * @see {@link addOrOmit} for adding or removing a service from an `Option`
 *
 * @category adders
 * @since 2.0.0
 */
export const add: {
  <I, S>(
    key: Key<I, S>,
    service: Types.NoInfer<S>
  ): <Services>(self: Context<Services>) => Context<Services | I>
  <Services, I, S>(
    self: Context<Services>,
    key: Key<I, S>,
    service: Types.NoInfer<S>
  ): Context<Services | I>
} = dual(3, <Services, I, S>(
  self: Context<Services>,
  key: Key<I, S>,
  service: Types.NoInfer<S>
): Context<Services | I> =>
  withMapUnsafe(self, (map) => {
    map.set(key.key, service)
  }))

/**
 * Adds or removes a service depending on an `Option`.
 *
 * **When to use**
 *
 * Use when you need to add or omit a `Context` service based on an `Option`.
 *
 * **Details**
 *
 * When `service` is `Option.some`, the value is stored for the key. When it is
 * `Option.none`, the key is removed from the returned `Context`.
 *
 * **Example** (Adding optional services)
 *
 * ```ts
 * import { Context, Option } from "effect"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 *
 * const withPort = Context.empty().pipe(
 *   Context.addOrOmit(Port, Option.some({ PORT: 8080 }))
 * )
 *
 * const withoutPort = withPort.pipe(
 *   Context.addOrOmit(Port, Option.none())
 * )
 * ```
 *
 * @see {@link add} for always storing a service value
 *
 * @category adders
 * @since 4.0.0
 */
export const addOrOmit: {
  <I, S>(
    key: Key<I, S>,
    service: Option.Option<Types.NoInfer<S>>
  ): <Services>(self: Context<Services>) => Context<Services | I>
  <Services, I, S>(
    self: Context<Services>,
    key: Key<I, S>,
    service: Option.Option<Types.NoInfer<S>>
  ): Context<Services | I>
} = dual(3, <Services, I, S>(
  self: Context<Services>,
  key: Key<I, S>,
  service: Option.Option<Types.NoInfer<S>>
): Context<Services | I> =>
  withMapUnsafe(self, (map) => {
    if (service._tag === "None") {
      map.delete(key.key)
    } else {
      map.set(key.key, service.value)
    }
  }))

/**
 * Gets the service for a key, or evaluates the fallback when a non-reference
 * key is absent.
 *
 * **When to use**
 *
 * Use when you need a fallback for a missing `Context.Service` key while still
 * resolving `Context.Reference` defaults.
 *
 * **Details**
 *
 * If the key is a `Context.Reference` and no override is stored in the
 * context, its cached default value is returned instead of the fallback.
 *
 * **Gotchas**
 *
 * The fallback is not evaluated for missing `Context.Reference` keys because
 * references resolve to their default value.
 *
 * **Example** (Falling back for missing services)
 *
 * ```ts
 * import { Context } from "effect"
 *
 * const Logger = Context.Service<{ log: (msg: string) => void }>("Logger")
 * const Database = Context.Service<{ query: (sql: string) => string }>(
 *   "Database"
 * )
 *
 * const context = Context.make(Logger, {
 *   log: (msg: string) => console.log(msg)
 * })
 *
 * const logger = Context.getOrElse(context, Logger, () => ({ log: () => {} }))
 * const database = Context.getOrElse(
 *   context,
 *   Database,
 *   () => ({ query: () => "fallback" })
 * )
 *
 * console.log(logger === Context.get(context, Logger)) // true
 * console.log(database.query("SELECT 1")) // "fallback"
 * ```
 *
 * @see {@link getOption} for returning `Option.none` when a non-reference key is missing
 *
 * @category getters
 * @since 3.7.0
 */
export const getOrElse: {
  <S, I, B>(key: Key<I, S>, orElse: LazyArg<B>): <Services>(self: Context<Services>) => S | B
  <Services, S, I, B>(self: Context<Services>, key: Key<I, S>, orElse: LazyArg<B>): S | B
} = dual(3, <Services, S, I, B>(self: Context<Services>, key: Key<I, S>, orElse: LazyArg<B>): S | B => {
  if (self.mapUnsafe.has(key.key)) {
    return self.mapUnsafe.get(key.key)! as any
  }
  return isReference(key) ? getDefaultValue(key) : orElse()
})

/**
 * Returns the service currently stored for a key, or `undefined` when the key
 * is absent.
 *
 * **When to use**
 *
 * Use when you need to read the service stored for a key without resolving
 * `Context.Reference` defaults.
 *
 * **Gotchas**
 *
 * This is a raw lookup and does not resolve default values for
 * `Context.Reference` keys.
 *
 * @see {@link getOption} for a reference-aware optional lookup
 *
 * @category getters
 * @since 4.0.0
 */
export const getOrUndefined: {
  <S, I>(key: Key<I, S>): <Services>(self: Context<Services>) => S | undefined
  <Services, S, I>(self: Context<Services>, key: Key<I, S>): S | undefined
} = dual(
  2,
  <Services, S, I>(self: Context<Services>, key: Key<I, S>): S | undefined => self.mapUnsafe.get(key.key)
)

/**
 * Gets the service for a key, throwing if an absent non-reference key cannot be
 * resolved.
 *
 * **When to use**
 *
 * Use when you need to read a service from a context whose type does not prove
 * the service is present.
 *
 * **Details**
 *
 * If the key is a `Context.Reference` and no override is stored in the
 * context, its cached default value is returned. For absent non-reference keys,
 * this function throws a runtime error.
 *
 * **Example** (Getting services unsafely)
 *
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const context = Context.make(Port, { PORT: 8080 })
 *
 * assert.deepStrictEqual(Context.getUnsafe(context, Port), { PORT: 8080 })
 * assert.throws(() => Context.getUnsafe(context, Timeout))
 * ```
 *
 * @see {@link get} for type-checked service access
 * @see {@link getOption} for optional service access
 *
 * @category unsafe
 * @since 4.0.0
 */
export const getUnsafe: {
  <S, I>(service: Key<I, S>): <Services>(self: Context<Services>) => S
  <Services, S, I>(self: Context<Services>, services: Key<I, S>): S
} = dual(
  2,
  <Services, I extends Services, S>(self: Context<Services>, service: Key<I, S>): S => {
    if (!self.mapUnsafe.has(service.key)) {
      if (ReferenceTypeId in service) return getDefaultValue(service as any)
      throw serviceNotFoundError(service)
    }
    return self.mapUnsafe.get(service.key)! as any
  }
)

/**
 * Gets a service from the context that corresponds to the given key.
 *
 * **When to use**
 *
 * Use when you need type-checked access to a service already included in the
 * context type.
 *
 * **Example** (Getting a service from a context)
 *
 * ```ts
 * import { Context, pipe } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const context = pipe(
 *   Context.make(Port, { PORT: 8080 }),
 *   Context.add(Timeout, { TIMEOUT: 5000 })
 * )
 *
 * assert.deepStrictEqual(Context.get(context, Timeout), { TIMEOUT: 5000 })
 * ```
 *
 * @see {@link getOption} for optional service access
 * @see {@link getOrElse} for fallback values
 *
 * @category getters
 * @since 2.0.0
 */
export const get: {
  <Services, I extends Services, S>(service: Key<I, S>): (self: Context<Services>) => S
  <Services, I extends Services, S>(self: Context<Services>, service: Key<I, S>): S
} = getUnsafe

/**
 * Gets the value for a `Context.Reference`, returning its cached default when
 * the context does not contain an override.
 *
 * **When to use**
 *
 * Use when you need a `Context.Reference` value resolved from either a stored
 * override or the reference's default value.
 *
 * **Details**
 *
 * Stored overrides take precedence. If no override is present, the reference's
 * default value is computed lazily and cached on the reference itself.
 *
 * **Gotchas**
 *
 * Mutable default values can be shared across contexts unless an override is
 * provided, because the default is cached on the `Context.Reference`.
 *
 * **Example** (Getting reference defaults unsafely)
 *
 * ```ts
 * import { Context } from "effect"
 *
 * const LoggerRef = Context.Reference("Logger", {
 *   defaultValue: () => ({ log: (msg: string) => console.log(msg) })
 * })
 *
 * const context = Context.empty()
 * const logger = Context.getReferenceUnsafe(context, LoggerRef)
 *
 * console.log(typeof logger.log) // "function"
 * ```
 *
 * @see {@link getUnsafe} for unsafe access with any service key
 * @see {@link get} for type-checked reference-aware access
 * @see {@link getOption} for optional access to non-reference keys
 *
 * @category unsafe
 * @since 4.0.0
 */
export const getReferenceUnsafe = <Services, S>(self: Context<Services>, service: Reference<S>): S => {
  if (!self.mapUnsafe.has(service.key)) {
    return getDefaultValue(service as any)
  }
  return self.mapUnsafe.get(service.key)! as any
}

const defaultValueCacheKey = "~effect/Context/defaultValue" as const

const getDefaultValue = (ref: Reference<any>) => {
  if (defaultValueCacheKey in ref) {
    return ref[defaultValueCacheKey] as any
  }
  return (ref as any)[defaultValueCacheKey] = ref.defaultValue()
}

const serviceNotFoundError = (service: Key<any, any>) => {
  const error = new Error(
    `Service not found${service.key ? `: ${String(service.key)}` : ""}`
  )
  if (service.stack) {
    const lines = service.stack.split("\n")
    if (lines.length > 2) {
      const afterAt = lines[2].match(/at (.*)/)
      if (afterAt) {
        error.message = error.message + ` (defined at ${afterAt[1]})`
      }
    }
  }
  if (error.stack) {
    const lines = error.stack.split("\n")
    lines.splice(1, 3)
    error.stack = lines.join("\n")
  }
  return error
}

/**
 * Gets the service for a key safely wrapped in an `Option`.
 *
 * **When to use**
 *
 * Use when you need to read a `Context` service as an `Option` so absence is
 * represented as data.
 *
 * **Details**
 *
 * Returns `Option.some` when the service is stored in the context. If the key
 * is a `Context.Reference` and no override is stored, returns `Option.some` of
 * the cached default value. Missing non-reference keys return `Option.none`.
 *
 * **Example** (Getting optional services)
 *
 * ```ts
 * import { Context, Option } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const context = Context.make(Port, { PORT: 8080 })
 *
 * assert.deepStrictEqual(
 *   Context.getOption(context, Port),
 *   Option.some({ PORT: 8080 })
 * )
 * assert.deepStrictEqual(Context.getOption(context, Timeout), Option.none())
 * ```
 *
 * @see {@link getOrElse} for returning a fallback value directly
 *
 * @category getters
 * @since 2.0.0
 */
export const getOption: {
  <S, I>(service: Key<I, S>): <Services>(self: Context<Services>) => Option.Option<S>
  <Services, S, I>(self: Context<Services>, service: Key<I, S>): Option.Option<S>
} = dual(2, <Services, I extends Services, S>(self: Context<Services>, service: Key<I, S>): Option.Option<S> => {
  if (self.mapUnsafe.has(service.key)) {
    return Option.some(self.mapUnsafe.get(service.key)! as any)
  }
  return isReference(service) ? Option.some(getDefaultValue(service as any)) : Option.none()
})

/**
 * Merges two `Context`s into one.
 *
 * **When to use**
 *
 * Use when you need to combine two contexts.
 *
 * **Details**
 *
 * When both contexts contain the same service key, the service from `that`
 * overrides the service from `self`.
 *
 * **Example** (Merging two contexts)
 *
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const firstContext = Context.make(Port, { PORT: 8080 })
 * const secondContext = Context.make(Timeout, { TIMEOUT: 5000 })
 *
 * const context = Context.merge(firstContext, secondContext)
 *
 * assert.deepStrictEqual(Context.get(context, Port), { PORT: 8080 })
 * assert.deepStrictEqual(Context.get(context, Timeout), { TIMEOUT: 5000 })
 * ```
 *
 * @see {@link mergeAll} for merging more than two contexts at once
 *
 * @category combining
 * @since 2.0.0
 */
export const merge: {
  <R1>(that: Context<R1>): <Services>(self: Context<Services>) => Context<R1 | Services>
  <Services, R1>(self: Context<Services>, that: Context<R1>): Context<Services | R1>
} = dual(2, <Services, R1>(self: Context<Services>, that: Context<R1>): Context<Services | R1> => {
  if (self.mapUnsafe.size === 0) return that as any
  if (that.mapUnsafe.size === 0) return self as any
  return withMapUnsafe(self, (map) => {
    that.mapUnsafe.forEach((value, key) => map.set(key, value))
  })
})

/**
 * Merges any number of `Context`s into one.
 *
 * **When to use**
 *
 * Use when you need to combine a variadic list of contexts.
 *
 * **Details**
 *
 * When multiple contexts contain the same service key, the service from the
 * last context with that key is kept.
 *
 * **Example** (Merging multiple contexts)
 *
 * ```ts
 * import { Context } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 * const Host = Context.Service<{ HOST: string }>("Host")
 *
 * const firstContext = Context.make(Port, { PORT: 8080 })
 * const secondContext = Context.make(Timeout, { TIMEOUT: 5000 })
 * const thirdContext = Context.make(Host, { HOST: "localhost" })
 *
 * const context = Context.mergeAll(
 *   firstContext,
 *   secondContext,
 *   thirdContext
 * )
 *
 * assert.deepStrictEqual(Context.get(context, Port), { PORT: 8080 })
 * assert.deepStrictEqual(Context.get(context, Timeout), { TIMEOUT: 5000 })
 * assert.deepStrictEqual(Context.get(context, Host), { HOST: "localhost" })
 * ```
 *
 * @see {@link merge} for merging two contexts
 *
 * @category combining
 * @since 3.12.0
 */
export const mergeAll = <T extends Array<unknown>>(
  ...ctxs: [...{ [K in keyof T]: Context<T[K]> }]
): Context<T[number]> => {
  const map = new Map()
  for (let i = 0; i < ctxs.length; i++) {
    ctxs[i].mapUnsafe.forEach((value, key) => {
      map.set(key, value)
    })
  }
  return makeUnsafe(map)
}

/**
 * Returns a new `Context` that contains only the specified services.
 *
 * **When to use**
 *
 * Use when you want to keep an allowlist of services in a `Context`.
 *
 * **Example** (Picking services from a context)
 *
 * ```ts
 * import { Context, Option, pipe } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const someContext = pipe(
 *   Context.make(Port, { PORT: 8080 }),
 *   Context.add(Timeout, { TIMEOUT: 5000 })
 * )
 *
 * const context = pipe(someContext, Context.pick(Port))
 *
 * assert.deepStrictEqual(
 *   Context.getOption(context, Port),
 *   Option.some({ PORT: 8080 })
 * )
 * assert.deepStrictEqual(Context.getOption(context, Timeout), Option.none())
 * ```
 *
 * @see {@link omit} for removing selected services
 *
 * @category filtering
 * @since 2.0.0
 */
export const pick = <S extends ReadonlyArray<Key<any, any>>>(
  ...services: S
) =>
<Services>(self: Context<Services>): Context<Services & Service.Identifier<S[number]>> =>
  withMapUnsafe(self, (map) => {
    const keySet = new Set(services.map((key) => key.key))
    map.forEach((_, key) => {
      if (keySet.has(key)) return
      map.delete(key)
    })
  })

/**
 * Returns a new `Context` with the specified service keys removed.
 *
 * **When to use**
 *
 * Use when you want to remove a denylist of services from a `Context`.
 *
 * **Example** (Omitting services from a context)
 *
 * ```ts
 * import { Context, Option, pipe } from "effect"
 * import * as assert from "node:assert"
 *
 * const Port = Context.Service<{ PORT: number }>("Port")
 * const Timeout = Context.Service<{ TIMEOUT: number }>("Timeout")
 *
 * const someContext = pipe(
 *   Context.make(Port, { PORT: 8080 }),
 *   Context.add(Timeout, { TIMEOUT: 5000 })
 * )
 *
 * const context = pipe(someContext, Context.omit(Timeout))
 *
 * assert.deepStrictEqual(
 *   Context.getOption(context, Port),
 *   Option.some({ PORT: 8080 })
 * )
 * assert.deepStrictEqual(Context.getOption(context, Timeout), Option.none())
 * ```
 *
 * @see {@link pick} for keeping selected services
 *
 * @category filtering
 * @since 2.0.0
 */
export const omit = <S extends ReadonlyArray<Key<any, any>>>(
  ...keys: S
) =>
<Services>(self: Context<Services>): Context<Exclude<Services, Service.Identifier<S[number]>>> =>
  withMapUnsafe(self, (map) => {
    for (let i = 0; i < keys.length; i++) {
      map.delete(keys[i].key)
    }
  })

/**
 * Performs a series of mutations on a `Context`. Prevents unnecessary copying
 * of the underlying map when multiple mutations are needed.
 *
 * **When to use**
 *
 * Use to apply several `Context` transformations in one callback while copying
 * the underlying service map only once.
 *
 * @see {@link add} for adding or replacing a service
 * @see {@link addOrOmit} for adding or removing a service from an `Option`
 * @see {@link merge} for combining two contexts
 * @see {@link pick} for keeping selected services
 * @see {@link omit} for removing selected services
 *
 * @category mutations
 * @since 4.0.0
 */
export const mutate: {
  <Services, B>(
    f: (context: Context<Services>) => Context<B>
  ): <Services>(self: Context<Services>) => Context<B>
  <Services, B>(self: Context<Services>, f: (context: Context<Services>) => Context<B>): Context<B>
} = dual(
  2,
  <Services, B>(self: Context<Services>, f: (context: Context<Services>) => Context<B>): Context<B> => {
    const next = makeUnsafe<Services>(new Map(self.mapUnsafe))
    next.mutable = true
    const result = f(next)
    result.mutable = false
    return result
  }
)

const withMapUnsafe = <Services, B>(self: Context<Services>, f: (map: Map<string, any>) => void): Context<B> => {
  if (self.mutable) {
    f(self.mapUnsafe as any)
    return self as any
  }
  const map = new Map(self.mapUnsafe)
  f(map)
  return makeUnsafe(map)
}

/**
 * Creates a context key with a default value.
 *
 * **When to use**
 *
 * Use when you need to define a context key with a lazily computed default
 * value.
 *
 * **Details**
 *
 * `Context.Reference` allows you to create a key that can hold a value. You
 * can provide a default value for the service, which will automatically be used
 * when the context is accessed, or override it with a custom implementation
 * when needed. The default value is computed lazily and cached on the
 * reference.
 *
 * **Example** (Creating references with default values)
 *
 * ```ts
 * import { Context } from "effect"
 *
 * // Create a reference with a default value
 * const LoggerRef = Context.Reference("Logger", {
 *   defaultValue: () => ({ log: (msg: string) => console.log(msg) })
 * })
 *
 * // The reference provides the default value when accessed from an empty context
 * const context = Context.empty()
 * const logger = Context.get(context, LoggerRef)
 *
 * // You can also override the default value
 * const customContext = Context.make(LoggerRef, {
 *   log: (msg: string) => `Custom: ${msg}`
 * })
 * const customLogger = Context.get(customContext, LoggerRef)
 * ```
 *
 * @see {@link Service} for required services without default values
 *
 * @category references
 * @since 3.11.0
 */
export const Reference: <Service>(
  key: string,
  options: { readonly defaultValue: () => Service }
) => Reference<Service> = Service as any
