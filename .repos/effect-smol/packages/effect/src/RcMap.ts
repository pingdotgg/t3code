/**
 * The `RcMap` module provides a scoped, reference-counted map for sharing
 * resources by key. It is useful when many fibers may request the same
 * resource, such as a connection, client, session, or cached handle, and the
 * resource should be acquired once, reused while it has active references, and
 * released automatically when it is no longer needed.
 *
 * Each key is resolved with a user-provided lookup effect on first access via
 * {@link get}. Further accesses to the same key share the in-flight or acquired
 * resource and increment its reference count for the caller's current
 * `Scope`. When those scopes close, references are released; resources can be
 * closed immediately, kept alive for an idle time-to-live, invalidated
 * explicitly, or bounded by a maximum capacity.
 *
 * `RcMap` is designed for Effect resource lifecycles rather than general
 * mutable caching. The map itself is scoped, lookups require a `Scope`, and
 * complex keys should provide `Equal` / `Hash` behavior when they need
 * value-based lookup semantics.
 *
 * @since 3.5.0
 */
import * as Cause from "./Cause.ts"
import { Clock } from "./Clock.ts"
import * as Context from "./Context.ts"
import * as Deferred from "./Deferred.ts"
import * as Duration from "./Duration.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import * as Fiber from "./Fiber.ts"
import { constant, dual, flow } from "./Function.ts"
import * as MutableHashMap from "./MutableHashMap.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import * as Scope from "./Scope.ts"

const TypeId = "~effect/RcMap"

/**
 * An `RcMap` is a reference-counted map data structure that manages the lifecycle
 * of resources indexed by keys. Resources are lazily acquired and automatically
 * released when no longer in use.
 *
 * **When to use**
 *
 * Use to share scoped resources by key while automatically releasing them after
 * their last active reference is gone.
 *
 * **Example** (Inspecting a reference-counted map)
 *
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   // Create an RcMap that manages database connections
 *   const dbConnectionMap = yield* RcMap.make({
 *     lookup: (dbName: string) =>
 *       Effect.acquireRelease(
 *         Effect.succeed(`Connection to ${dbName}`),
 *         (conn) => Effect.log(`Closing ${conn}`)
 *       ),
 *     capacity: 10,
 *     idleTimeToLive: "5 minutes"
 *   })
 *
 *   // The RcMap interface provides access to:
 *   // - lookup: Function to acquire resources
 *   // - capacity: Maximum number of resources
 *   // - idleTimeToLive: Time before idle resources are released
 *   // - state: Current state of the map
 *
 *   console.log(`Capacity: ${dbConnectionMap.capacity}`)
 * }).pipe(Effect.scoped)
 * ```
 *
 * @see {@link make} for creating an `RcMap`
 * @see {@link get} for acquiring or retaining a resource by key
 *
 * @category models
 * @since 3.5.0
 */
export interface RcMap<in out K, in out A, in out E = never> extends Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly lookup: (key: K) => Effect.Effect<A, E, Scope.Scope>
  readonly context: Context.Context<never>
  readonly scope: Scope.Scope
  readonly idleTimeToLive: (key: K) => Duration.Duration
  readonly capacity: number
  state: State<K, A, E>
}

/**
 * Represents the internal state of an RcMap, which can be either Open (active)
 * or Closed (shutdown and no longer accepting operations).
 *
 * **When to use**
 *
 * Use when typing code that inspects an `RcMap`'s `state` field and narrows
 * between open and closed lifecycle states.
 *
 * @see {@link RcMap} for the map value that exposes this state
 * @see {@link State.Open} for the active state with entries
 * @see {@link State.Closed} for the shutdown state
 *
 * @category models
 * @since 4.0.0
 */
export type State<K, A, E> = State.Open<K, A, E> | State.Closed

/**
 * Namespace containing the internal state types for RcMap.
 *
 * **When to use**
 *
 * Use when referring to the concrete open, closed, and entry state shapes used
 * by `RcMap`.
 *
 * @since 4.0.0
 */
export declare namespace State {
  /**
   * Represents the open/active state of an RcMap, containing the actual
   * resource map that stores entries.
   *
   * **When to use**
   *
   * Use when handling an `RcMap` that can still accept operations and contains
   * stored entries.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Open<K, A, E> {
    readonly _tag: "Open"
    readonly map: MutableHashMap.MutableHashMap<K, Entry<A, E>>
  }

  /**
   * Represents the closed state of an RcMap, indicating that the map has been
   * shut down and will no longer accept new operations.
   *
   * **When to use**
   *
   * Use when handling an `RcMap` after its owning scope has closed.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Closed {
    readonly _tag: "Closed"
  }

  /**
   * Represents an individual entry in the RcMap, containing the resource's
   * metadata including reference count, expiration time, and lifecycle management.
   *
   * **When to use**
   *
   * Use when inspecting the stored resource, reference count, and idle lifecycle
   * metadata for a single key.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Entry<A, E> {
    readonly deferred: Deferred.Deferred<A, E>
    readonly scope: Scope.Closeable
    readonly finalizer: Effect.Effect<void>
    readonly idleTimeToLive: Duration.Duration
    fiber: Fiber.Fiber<void> | undefined
    expiresAt: number
    refCount: number
  }
}

const makeUnsafe = <K, A, E>(options: {
  readonly lookup: (key: K) => Effect.Effect<A, E, Scope.Scope>
  readonly context: Context.Context<never>
  readonly scope: Scope.Scope
  readonly idleTimeToLive: (key: K) => Duration.Duration
  readonly capacity: number
}): RcMap<K, A, E> => ({
  [TypeId]: TypeId,
  lookup: options.lookup,
  context: options.context,
  scope: options.scope,
  idleTimeToLive: options.idleTimeToLive,
  capacity: options.capacity,
  state: {
    _tag: "Open",
    map: MutableHashMap.empty()
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
})

/**
 * Creates an `RcMap` that can contain multiple reference counted resources that can be indexed
 * by a key. The resources are lazily acquired on the first call to `get` and
 * released when the last reference is released.
 *
 * **When to use**
 *
 * Use to create a scoped reference-counted map for resources that should be
 * acquired once per key and shared while in use.
 *
 * **Details**
 *
 * Complex keys can extend `Equal` and `Hash` to allow lookups by value.
 *
 * - `capacity`: The maximum number of resources that can be held in the map.
 * - `idleTimeToLive`: When the reference count reaches zero, the resource will be released after this duration.
 *
 * **Example** (Creating a reference-counted map)
 *
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* RcMap.make({
 *     lookup: (key: string) =>
 *       Effect.acquireRelease(
 *         Effect.succeed(`acquired ${key}`),
 *         () => Effect.log(`releasing ${key}`)
 *       )
 *   })
 *
 *   // Get "foo" from the map twice, which will only acquire it once.
 *   // It will then be released once the scope closes.
 *   yield* RcMap.get(map, "foo").pipe(
 *     Effect.andThen(RcMap.get(map, "foo")),
 *     Effect.scoped
 *   )
 * })
 * ```
 *
 * @see {@link get} for acquiring or retaining a resource by key
 * @see {@link invalidate} for removing a resource from the map
 *
 * @category models
 * @since 3.5.0
 */
export const make: {
  <K, A, E, R>(options: {
    readonly lookup: (key: K) => Effect.Effect<A, E, R>
    readonly idleTimeToLive?: Duration.Input | ((key: K) => Duration.Input) | undefined
    readonly capacity?: undefined
  }): Effect.Effect<RcMap<K, A, E>, never, Scope.Scope | R>
  <K, A, E, R>(options: {
    readonly lookup: (key: K) => Effect.Effect<A, E, R>
    readonly idleTimeToLive?: Duration.Input | ((key: K) => Duration.Input) | undefined
    readonly capacity: number
  }): Effect.Effect<RcMap<K, A, E | Cause.ExceededCapacityError>, never, Scope.Scope | R>
} = <K, A, E, R>(options: {
  readonly lookup: (key: K) => Effect.Effect<A, E, R>
  readonly idleTimeToLive?: Duration.Input | ((key: K) => Duration.Input) | undefined
  readonly capacity?: number | undefined
}) =>
  Effect.withFiber<RcMap<K, A, E>, never, R | Scope.Scope>((fiber) => {
    const context = fiber.context as Context.Context<R | Scope.Scope>
    const scope = Context.get(context, Scope.Scope)
    const self = makeUnsafe<K, A, E>({
      lookup: options.lookup as any,
      context,
      scope,
      idleTimeToLive: typeof options.idleTimeToLive === "function"
        ? flow(options.idleTimeToLive, Duration.fromInputUnsafe)
        : constant(Duration.fromInputUnsafe(options.idleTimeToLive ?? Duration.zero)),
      capacity: Math.max(options.capacity ?? Number.POSITIVE_INFINITY, 0)
    })
    return Effect.as(
      Scope.addFinalizerExit(scope, () => {
        if (self.state._tag === "Closed") {
          return Effect.void
        }
        const map = self.state.map
        self.state = { _tag: "Closed" }
        return Effect.forEach(
          map,
          ([, entry]) => Effect.exit(Scope.close(entry.scope, Exit.void))
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              MutableHashMap.clear(map)
            })
          )
        )
      }),
      self
    )
  })

/**
 * Gets the resource for a key, acquiring it with the map's lookup function when
 * the key is not already cached.
 *
 * **When to use**
 *
 * Use to acquire or retain the resource for a key within the current scope.
 *
 * **Details**
 *
 * The resource's reference count is incremented for the current `Scope`, and a
 * release finalizer is added to that scope. When the current scope closes, the
 * reference is released; the resource is closed when the last reference is
 * released, subject to the map's idle time-to-live setting.
 *
 * **Example** (Acquiring a resource)
 *
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* RcMap.make({
 *     lookup: (key: string) =>
 *       Effect.acquireRelease(
 *         Effect.succeed(`Resource: ${key}`),
 *         () => Effect.log(`Released ${key}`)
 *       )
 *   })
 *
 *   // Get a resource - it will be acquired on first access
 *   const resource = yield* RcMap.get(map, "database")
 *   console.log(resource) // "Resource: database"
 * }).pipe(Effect.scoped)
 * ```
 *
 * @see {@link make} for creating the reference-counted map
 * @see {@link invalidate} for removing a resource by key
 *
 * @category combinators
 * @since 3.5.0
 */
export const get: {
  <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<A, E, Scope.Scope>
  <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<A, E, Scope.Scope>
} = dual(
  2,
  <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<A, E, Scope.Scope> =>
    Effect.uninterruptibleMask((restore) => {
      if (self.state._tag === "Closed") {
        return Effect.interrupt
      }
      const state = self.state
      const parent = Fiber.getCurrent()!
      const o = MutableHashMap.get(state.map, key)
      let entry: State.Entry<A, E>
      if (o._tag === "Some") {
        entry = o.value
        entry.refCount++
      } else if (Number.isFinite(self.capacity) && MutableHashMap.size(self.state.map) >= self.capacity) {
        return Effect.fail(
          new Cause.ExceededCapacityError(`RcMap attempted to exceed capacity of ${self.capacity}`)
        ) as Effect.Effect<never>
      } else {
        entry = {
          deferred: Deferred.makeUnsafe(),
          scope: Scope.makeUnsafe(),
          idleTimeToLive: self.idleTimeToLive(key),
          finalizer: undefined as any,
          fiber: undefined,
          expiresAt: 0,
          refCount: 1
        }
        ;(entry as any).finalizer = release(self, key, entry)
        MutableHashMap.set(state.map, key, entry)
        const context = new Map(self.context.mapUnsafe)
        parent.context.mapUnsafe.forEach((value, key) => {
          context.set(key, value)
        })
        context.set(Scope.Scope.key, entry.scope)
        self.lookup(key).pipe(
          Effect.runForkWith(Context.makeUnsafe(context)),
          Fiber.runIn(entry.scope)
        ).addObserver((exit) => Deferred.doneUnsafe(entry.deferred, exit))
      }
      const scope = Context.getUnsafe(parent.context, Scope.Scope)
      return Scope.addFinalizer(scope, entry.finalizer).pipe(
        Effect.andThen(restore(Deferred.await(entry.deferred)))
      )
    })
)

const release = <K, A, E>(self: RcMap<K, A, E>, key: K, entry: State.Entry<A, E>) =>
  Effect.withFiber((fiber) => {
    entry.refCount--
    if (entry.refCount > 0) {
      return Effect.void
    } else if (
      self.state._tag === "Closed"
      || !MutableHashMap.has(self.state.map, key)
      || Duration.isZero(entry.idleTimeToLive)
    ) {
      if (self.state._tag === "Open") {
        MutableHashMap.remove(self.state.map, key)
      }
      return Scope.close(entry.scope, Exit.void)
    } else if (!Duration.isFinite(entry.idleTimeToLive)) {
      return Effect.void
    }

    const clock = fiber.getRef(Clock)
    entry.expiresAt = clock.currentTimeMillisUnsafe() + Duration.toMillis(entry.idleTimeToLive)
    if (entry.fiber) return Effect.void

    entry.fiber = Effect.interruptibleMask(function loop(restore): Effect.Effect<void> {
      const now = clock.currentTimeMillisUnsafe()
      const remaining = entry.expiresAt - now
      if (remaining <= 0) {
        if (self.state._tag === "Closed" || entry.refCount > 0) return Effect.void
        MutableHashMap.remove(self.state.map, key)
        return restore(Scope.close(entry.scope, Exit.void))
      }
      return Effect.flatMap(clock.sleep(Duration.millis(remaining)), () => loop(restore))
    }).pipe(
      Effect.ensuring(Effect.sync(() => {
        entry.fiber = undefined
      })),
      Effect.runForkWith(fiber.context),
      Fiber.runIn(self.scope)
    )
    return Effect.void
  })

/**
 * Returns an iterable of all keys currently stored in the `RcMap`.
 *
 * **When to use**
 *
 * Use to inspect which keys currently have stored resources in an `RcMap`.
 *
 * **Details**
 *
 * If the `RcMap` has been closed, the effect is interrupted.
 *
 * **Example** (Listing keys)
 *
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* RcMap.make({
 *     lookup: (key: string) => Effect.succeed(`value-${key}`)
 *   })
 *
 *   // Add some resources to the map
 *   yield* RcMap.get(map, "foo")
 *   yield* RcMap.get(map, "bar")
 *   yield* RcMap.get(map, "baz")
 *
 *   // Get all keys currently in the map
 *   const allKeys = yield* RcMap.keys(map)
 *   console.log(allKeys) // ["foo", "bar", "baz"]
 * }).pipe(Effect.scoped)
 * ```
 *
 * @see {@link has} for checking one key without enumerating all keys
 *
 * @category combinators
 * @since 3.8.0
 */
export const keys = <K, A, E>(self: RcMap<K, A, E>): Effect.Effect<Iterable<K>> => {
  return Effect.suspend(() =>
    self.state._tag === "Closed" ? Effect.interrupt : Effect.succeed(MutableHashMap.keys(self.state.map))
  )
}

/**
 * Invalidates and removes a specific key from the RcMap. If the resource is not
 * currently in use (reference count is 0), it will be immediately released.
 *
 * **When to use**
 *
 * Use to remove a resource by key so the next access performs a fresh lookup.
 *
 * **Example** (Invalidating a resource)
 *
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* RcMap.make({
 *     lookup: (key: string) =>
 *       Effect.acquireRelease(
 *         Effect.succeed(`Resource: ${key}`),
 *         () => Effect.log(`Released ${key}`)
 *       )
 *   })
 *
 *   // Get a resource
 *   yield* RcMap.get(map, "cache")
 *
 *   // Invalidate the resource - it will be removed from the map
 *   // and released if no longer in use
 *   yield* RcMap.invalidate(map, "cache")
 *
 *   // Next access will create a new resource
 *   yield* RcMap.get(map, "cache")
 * }).pipe(Effect.scoped)
 * ```
 *
 * @see {@link get} for acquiring or retaining the resource for a key
 * @see {@link touch} for extending the idle lifetime without removing the entry
 *
 * @category combinators
 * @since 3.13.0
 */
export const invalidate: {
  <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<void>
  <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<void>
} = dual(
  2,
  Effect.fnUntraced(function*<K, A, E>(self: RcMap<K, A, E>, key: K) {
    if (self.state._tag === "Closed") return
    const o = MutableHashMap.get(self.state.map, key)
    if (o._tag === "None") return
    const entry = o.value
    MutableHashMap.remove(self.state.map, key)
    if (entry.refCount > 0) return
    if (entry.fiber) yield* Fiber.interrupt(entry.fiber)
    yield* Scope.close(entry.scope, Exit.void)
  }, Effect.uninterruptible)
)

/**
 * Returns whether the `RcMap` currently contains an entry for the specified
 * key.
 *
 * **When to use**
 *
 * Use to check whether a key is already present in an `RcMap` without running
 * the lookup function or acquiring a missing resource.
 *
 * **Details**
 *
 * This operation only checks the current map state.
 *
 * **Gotchas**
 *
 * Closed maps return `false`, so `false` does not distinguish a missing key
 * from a closed map.
 *
 * @see {@link get} for acquiring or retaining the resource for a key
 * @see {@link keys} for enumerating all currently stored keys
 *
 * @category combinators
 * @since 3.17.7
 */
export const has: {
  <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<boolean>
  <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<boolean>
} = dual(
  2,
  <K, A, E>(self: RcMap<K, A, E>, key: K) =>
    Effect.sync(() => {
      if (self.state._tag === "Closed") return false
      return MutableHashMap.has(self.state.map, key)
    })
)

/**
 * Extends the idle time for a resource in the RcMap. If the RcMap has an
 * `idleTimeToLive` configured, calling `touch` will reset the expiration
 * timer for the specified key.
 *
 * **When to use**
 *
 * Use to keep an idle resource alive longer without acquiring a new reference.
 *
 * **Example** (Extending resource idle time)
 *
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* RcMap.make({
 *     lookup: (key: string) =>
 *       Effect.acquireRelease(
 *         Effect.succeed(`Resource: ${key}`),
 *         () => Effect.log(`Released ${key}`)
 *       ),
 *     idleTimeToLive: "10 seconds"
 *   })
 *
 *   // Get a resource
 *   yield* RcMap.get(map, "session")
 *
 *   // Touch the resource to extend its idle time
 *   // This resets the 10-second expiration timer
 *   yield* RcMap.touch(map, "session")
 *
 *   // The resource will now live for another 10 seconds
 *   // from the time it was touched
 * }).pipe(Effect.scoped)
 * ```
 *
 * @see {@link invalidate} for removing the resource instead of extending it
 *
 * @category combinators
 * @since 3.13.0
 */
export const touch: {
  <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<void>
  <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<void>
} = dual(
  2,
  <K, A, E>(self: RcMap<K, A, E>, key: K) =>
    Effect.clockWith((clock) => {
      if (self.state._tag === "Closed") {
        return Effect.void
      }
      const o = MutableHashMap.get(self.state.map, key)
      if (o._tag === "None" || Duration.isZero(o.value.idleTimeToLive)) {
        return Effect.void
      }
      const entry = o.value
      entry.expiresAt = clock.currentTimeMillisUnsafe() + Duration.toMillis(entry.idleTimeToLive)
      return Effect.void
    })
)
