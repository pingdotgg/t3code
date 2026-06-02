/**
 * Combines scoped memory caching with durable persistence for `Persistable`
 * lookup keys.
 *
 * A `PersistedCache` first checks a process-local `Cache`, then a named
 * `Persistence` store, before running the supplied lookup. It is designed for
 * expensive or idempotent requests whose encoded `Exit` can be reused across
 * fibers, process restarts, or multiple workers sharing the same backing store.
 *
 * **Mental model**
 *
 * `make` creates a scoped cache backed by a scoped persistence store. The memory
 * cache controls repeated reads inside the current runtime with `inMemoryTTL`
 * and capacity, while the persistence store controls durable reuse with
 * `timeToLive`, `storeId`, and request primary keys. Both successes and failures
 * are stored as `Exit` values when the persistent TTL allows the write.
 *
 * **Common tasks**
 *
 * Use `get` for lookups that should reuse memory and persisted values, and use
 * `invalidate` when the underlying data changes so both layers forget the key.
 * Use `requireServicesAt` to choose whether lookup services are supplied when
 * constructing the cache or when reading from it.
 *
 * **Gotchas**
 *
 * Persisted entries are decoded with the key's success and error schemas.
 * Changing schemas, primary-key formats, or `storeId` values is a persistence
 * migration; old entries can stop being found or fail to decode. `invalidate`
 * removes the persisted value first and then the in-memory entry.
 *
 * @since 4.0.0
 */
import * as Cache from "../../Cache.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import type { Exit } from "../../Exit.ts"
import { constant, identity } from "../../Function.ts"
import type * as Schema from "../../Schema.ts"
import type * as Scope from "../../Scope.ts"
import type * as Persistable from "./Persistable.ts"
import * as Persistence from "./Persistence.ts"

const TypeId = "~effect/persistence/PersistedCache" as const

/**
 * Cache that combines an in-memory `Cache` with a persisted backing store.
 *
 * @category models
 * @since 4.0.0
 */
export interface PersistedCache<K extends Persistable.Any, out R = never> {
  readonly [TypeId]: typeof TypeId
  readonly inMemory: Cache.Cache<
    K,
    Persistable.Success<K>,
    Persistable.Error<K> | Persistence.PersistenceError | Schema.SchemaError,
    Persistable.Services<K> | R
  >
  readonly get: (key: K) => Effect.Effect<
    Persistable.Success<K>,
    Persistable.Error<K> | Persistence.PersistenceError | Schema.SchemaError,
    Persistable.Services<K> | R
  >
  readonly invalidate: (key: K) => Effect.Effect<void, Persistence.PersistenceError>
}

/**
 * Creates a persisted cache for `Persistable` request keys.
 *
 * **Details**
 *
 * The cache reads persisted exits before running the lookup, stores lookup
 * exits with the configured persistent TTL, and also keeps a scoped in-memory
 * cache with its own capacity and TTL.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: <
  K extends Persistable.Any,
  R = never,
  ServiceMode extends "lookup" | "construction" = never
>(lookup: (key: K) => Effect.Effect<Persistable.Success<K>, Persistable.Error<K>, R>, options: {
  readonly storeId: string
  readonly timeToLive: Persistable.TimeToLiveFn<K>
  readonly inMemoryCapacity?: number | undefined
  readonly inMemoryTTL?: Persistable.TimeToLiveFn<K> | undefined
  readonly requireServicesAt?: ServiceMode | undefined
}) => Effect.Effect<
  PersistedCache<K, "lookup" extends ServiceMode ? R : never>,
  never,
  ("lookup" extends ServiceMode ? never : R) | Persistence.Persistence | Scope.Scope
> = Effect.fnUntraced(function*<
  K extends Persistable.Any,
  R = never,
  ServiceMode extends "lookup" | "construction" = never
>(
  lookup: (key: K) => Effect.Effect<Persistable.Success<K>, Persistable.Error<K>, R>,
  options: {
    readonly storeId: string
    readonly timeToLive: Persistable.TimeToLiveFn<K>
    readonly inMemoryCapacity?: number | undefined
    readonly inMemoryTTL?: Persistable.TimeToLiveFn<K> | undefined
    readonly requireServicesAt?: ServiceMode | undefined
  }
) {
  const store = yield* (yield* Persistence.Persistence).make({
    storeId: options.storeId,
    timeToLive: options.timeToLive as any
  })
  const inMemory = yield* Cache.makeWith(
    Effect.fnUntraced(function*(key: K) {
      const exit = yield* (store.get(key) as Effect.Effect<Exit<Persistable.Success<K>, Persistable.Error<K>>>)
      if (exit) {
        return yield* exit
      }
      const result = yield* Effect.exit(lookup(key))
      yield* (store.set(key, result) as Effect.Effect<void>)
      return yield* result
    }),
    {
      timeToLive: options.inMemoryTTL ?? constant(Duration.seconds(10)),
      capacity: options.inMemoryCapacity ?? 1024,
      requireServicesAt: options.requireServicesAt
    }
  )
  return identity<PersistedCache<K, "lookup" extends ServiceMode ? R : never>>({
    [TypeId]: TypeId,
    inMemory,
    get: (key) => Cache.get(inMemory, key),
    invalidate: (key) => Effect.flatMap(store.remove(key), () => Cache.invalidate(inMemory, key))
  })
})
