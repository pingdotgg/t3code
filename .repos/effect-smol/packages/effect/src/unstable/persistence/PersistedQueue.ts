/**
 * Stores schema-encoded queue work in persistent storage.
 *
 * A `PersistedQueue<A>` keeps JSON-encoded values in a named queue and lets
 * workers take one value at a time inside a scoped processing window. It is
 * useful for durable handoffs, background jobs, outbox-style integrations, and
 * work that should retry across fibers, process restarts, or multiple workers.
 * This module includes a queue factory, store service, id-based de-duplication,
 * retry handling, and in-memory, Redis, and SQL-backed store layers.
 *
 * @since 4.0.0
 */
import type * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Context from "../../Context.ts"
import * as Data from "../../Data.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import { flow } from "../../Function.ts"
import * as Iterable from "../../Iterable.ts"
import * as Latch from "../../Latch.ts"
import * as Layer from "../../Layer.ts"
import * as MutableRef from "../../MutableRef.ts"
import * as Queue from "../../Queue.ts"
import * as RcMap from "../../RcMap.ts"
import * as Schedule from "../../Schedule.ts"
import * as Schema from "../../Schema.ts"
import * as Scope from "../../Scope.ts"
import * as SqlClient from "../sql/SqlClient.ts"
import type { SqlError } from "../sql/SqlError.ts"
import * as Redis from "./Redis.ts"

/**
 * Runtime type identifier for `PersistedQueue` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~effect/persistence/PersistedQueue"

/**
 * Type-level identifier used to brand `PersistedQueue` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~effect/persistence/PersistedQueue"

/**
 * Persistent queue of schema-encoded values.
 *
 * **Details**
 *
 * `offer` enqueues values by id, and `take` processes one value at a time,
 * marking it complete on success or retrying it until the maximum attempts is
 * reached.
 *
 * @category models
 * @since 4.0.0
 */
export interface PersistedQueue<in out A, out R = never> {
  readonly [TypeId]: TypeId

  /**
   * Adds an element to the queue and returns the id of the enqueued element.
   *
   * **Details**
   *
   * If an element with the same id already exists in the queue, it will not be
   * added again.
   */
  readonly offer: (value: A, options?: {
    readonly id: string | undefined
  }) => Effect.Effect<string, PersistedQueueError | Schema.SchemaError, R>

  /**
   * Takes an element from the queue, waiting until one is available when the
   * queue is empty.
   *
   * **Details**
   *
   * If the returned effect succeeds, the element is marked as processed;
   * otherwise it will be retried according to the provided options. By default,
   * max attempts is set to 10.
   */
  readonly take: <XA, XE, XR>(
    f: (value: A, metadata: {
      readonly id: string
      readonly attempts: number
    }) => Effect.Effect<XA, XE, XR>,
    options?: {
      readonly maxAttempts?: number | undefined
    }
  ) => Effect.Effect<XA, XE | PersistedQueueError | Schema.SchemaError, R | XR>
}

/**
 * Service for constructing named `PersistedQueue` instances from schemas.
 *
 * @category services
 * @since 4.0.0
 */
export class PersistedQueueFactory extends Context.Service<
  PersistedQueueFactory,
  {
    readonly make: <S extends Schema.Constraint>(options: {
      readonly name: string
      readonly schema: S
    }) => Effect.Effect<PersistedQueue<S["Type"], S["EncodingServices"] | S["DecodingServices"]>>
  }
>()("effect/persistence/PersistedQueue/PersistedQueueFactory") {}

/**
 * Accesses `PersistedQueueFactory` to create a named persisted queue for a
 * schema.
 *
 * @category accessors
 * @since 4.0.0
 */
export const make = <S extends Schema.Constraint>(options: {
  readonly name: string
  readonly schema: S
}): Effect.Effect<
  PersistedQueue<S["Type"], S["EncodingServices"] | S["DecodingServices"]>,
  never,
  PersistedQueueFactory
> => PersistedQueueFactory.use((factory) => factory.make(options))

/**
 * Creates a `PersistedQueueFactory` from the current `PersistedQueueStore`.
 *
 * **Details**
 *
 * Values are encoded and decoded with the supplied schema, automatically
 * assigned an id when needed, and acknowledged or retried according to the
 * `take` handler's exit.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeFactory = Effect.gen(function*() {
  const store = yield* PersistedQueueStore

  return PersistedQueueFactory.of({
    make<S extends Schema.Constraint>(options: {
      readonly name: string
      readonly schema: S
    }) {
      const jsonSchema = Schema.toCodecJson(options.schema)
      const encodeUnknown = Schema.encodeUnknownEffect(jsonSchema)
      const decodeUnknown = Schema.decodeUnknownEffect(jsonSchema)

      return Effect.succeed<PersistedQueue<S["Type"], S["EncodingServices"] | S["DecodingServices"]>>({
        [TypeId]: TypeId,
        offer: (value, opts) =>
          Effect.flatMap(
            encodeUnknown(value),
            (element) => {
              const id = opts?.id ?? crypto.randomUUID()
              return Effect.as(
                store.offer({
                  name: options.name,
                  id,
                  element,
                  isCustomId: opts?.id !== undefined
                }),
                id
              )
            }
          ),
        take: (f, opts) =>
          Effect.scopedWith(Effect.fnUntraced(function*(scope) {
            const item = yield* store.take({
              name: options.name,
              maxAttempts: opts?.maxAttempts ?? 10
            }).pipe(Scope.provide(scope))
            const decoded = yield* decodeUnknown(item.element)
            return yield* f(decoded, { id: item.id, attempts: item.attempts })
          }))
      })
    }
  })
})

/**
 * Provides `PersistedQueueFactory` using the current `PersistedQueueStore`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<
  PersistedQueueFactory,
  never,
  PersistedQueueStore
> = Layer.effect(PersistedQueueFactory, makeFactory)

/**
 * Runtime type identifier for `PersistedQueueError`.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const ErrorTypeId: ErrorTypeId = "~@effect/experimental/PersistedQueue/PersistedQueueError"

/**
 * Type-level identifier used to brand `PersistedQueueError` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type ErrorTypeId = "~@effect/experimental/PersistedQueue/PersistedQueueError"

/**
 * Error raised by persisted queue store operations.
 *
 * @category errors
 * @since 4.0.0
 */
export class PersistedQueueError extends Schema.ErrorClass<PersistedQueueError>(
  "effect/persistence/PersistedQueue/PersistedQueueError"
)({
  _tag: Schema.tag("PersistedQueueError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {
  /**
   * Marks this value as a persisted queue error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ErrorTypeId]: ErrorTypeId = ErrorTypeId
}

/**
 * Defines the low-level backing store service used by `PersistedQueue`.
 *
 * **When to use**
 *
 * Use to provide the persistence backend that stores queued elements, scoped
 * takes, retry attempts, and acknowledgements.
 *
 * **Details**
 *
 * The store persists offered elements and returns taken elements in a scope so
 * the finalizer can complete or retry them based on the processing exit.
 *
 * @category store
 * @since 4.0.0
 */
export class PersistedQueueStore extends Context.Service<
  PersistedQueueStore,
  {
    readonly offer: (
      options: {
        readonly name: string
        readonly id: string
        readonly element: unknown
        readonly isCustomId: boolean
      }
    ) => Effect.Effect<void, PersistedQueueError>

    readonly take: (options: {
      readonly name: string
      readonly maxAttempts: number
    }) => Effect.Effect<
      {
        readonly id: string
        readonly attempts: number
        readonly element: unknown
      },
      PersistedQueueError,
      Scope.Scope
    >
  }
>()("effect/persistence/PersistedQueue/PersistedQueueStore") {}

/**
 * Provides an in-memory `PersistedQueueStore`.
 *
 * **Details**
 *
 * The store is process-local and volatile; failed takes are requeued until the
 * configured maximum attempts is reached.
 *
 * @category store
 * @since 4.0.0
 */
export const layerStoreMemory: Layer.Layer<
  PersistedQueueStore
> = Layer.sync(PersistedQueueStore, () => {
  type Entry = {
    readonly id: string
    attempts: number
    readonly element: unknown
  }
  const ids = new Set<string>()
  const queues = new Map<string, {
    latch: Latch.Latch
    items: Set<Entry>
  }>()
  const getOrCreateQueue = (name: string) => {
    let queue = queues.get(name)
    if (!queue) {
      queue = {
        latch: Latch.makeUnsafe(false),
        items: new Set()
      }
      queues.set(name, queue)
    }
    return queue
  }

  return PersistedQueueStore.of({
    offer: (options) =>
      Effect.sync(() => {
        if (ids.has(options.id)) return
        ids.add(options.id)
        const queue = getOrCreateQueue(options.name)
        queue.items.add({ id: options.id, attempts: 0, element: options.element })
        queue.latch.openUnsafe()
      }),
    take: Effect.fnUntraced(function*(options) {
      const queue = getOrCreateQueue(options.name)
      while (true) {
        yield* queue.latch.await
        const item = Iterable.headUnsafe(queue.items)
        queue.items.delete(item)
        if (queue.items.size === 0) {
          queue.latch.closeUnsafe()
        }
        yield* Effect.addFinalizer((exit) => {
          if (exit._tag === "Success") {
            return Effect.void
          } else if (!Exit.hasInterrupts(exit)) {
            item.attempts += 1
          }
          if (item.attempts >= options.maxAttempts) {
            return Effect.void
          }
          queue.items.add(item)
          queue.latch.openUnsafe()
          return Effect.void
        })
        return item
      }
    })
  })
})

/**
 * Creates a Redis-backed `PersistedQueueStore`.
 *
 * **Details**
 *
 * The store uses Redis lists and hashes with worker locks, periodically
 * refreshes locks while items are being processed, and moves exhausted items
 * to a failed queue.
 *
 * @category store
 * @since 4.0.0
 */
export const makeStoreRedis = Effect.fnUntraced(function*(
  options?: {
    readonly prefix?: string | undefined
    readonly pollInterval?: Duration.Input | undefined
    readonly lockRefreshInterval?: Duration.Input | undefined
    readonly lockExpiration?: Duration.Input | undefined
  }
) {
  const redis = yield* Redis.Redis

  const pollInterval = Duration.max(
    options?.pollInterval ? Duration.fromInputUnsafe(options.pollInterval) : Duration.seconds(1),
    Duration.millis(1)
  )
  const lockRefreshMillis = Math.max(
    options?.lockRefreshInterval
      ? Duration.toMillis(Duration.fromInputUnsafe(options.lockRefreshInterval))
      : 30_000,
    1
  )
  const lockExpirationMillis = Math.max(
    options?.lockExpiration
      ? Duration.toMillis(Duration.fromInputUnsafe(options.lockExpiration))
      : 90_000,
    1
  )
  const prefix = options?.prefix ?? "effectq:"
  const keyQueue = (name: string) => `${prefix}${name}`
  const keyLock = (id: string) => `${prefix}${id}:lock`
  const keyPending = (name: string) => `${prefix}${name}:pending`
  const keyFailed = (name: string) => `${prefix}${name}:failed`
  const workerId = crypto.randomUUID()

  type Element = {
    readonly id: string
    readonly element: unknown
    attempts: number
    lastFailure?: string
  }

  const requeue = redis.eval(requeueRedis)
  const complete = redis.eval(completeRedis)
  const failed = redis.eval(failedRedis)
  const resetQueue = redis.eval(resetQueueRedis)
  const offer = redis.eval(offerRedis)
  const take = redis.eval(takeRedis)
  const expireAll = redis.eval(expireAllRedis)

  const queues = yield* RcMap.make({
    lookup: Effect.fnUntraced(function*(name: string) {
      const queueKey = keyQueue(name)
      const pendingKey = keyPending(name)
      const queue = yield* Queue.make<Element>()
      const takers = MutableRef.make(0)
      const pollLatch = Latch.makeUnsafe()
      const takenLatch = Latch.makeUnsafe()

      yield* Effect.addFinalizer(() =>
        Effect.orDie(
          Effect.flatMap(
            Queue.clear(queue),
            (elements) =>
              Effect.forEach(elements, (element) =>
                requeue(
                  queueKey,
                  pendingKey,
                  keyLock(element.id),
                  element.id,
                  JSON.stringify(element)
                ), { concurrency: "unbounded", discard: true })
          )
        )
      )

      yield* resetQueue(queueKey, pendingKey, prefix).pipe(
        Effect.andThen(Effect.sleep(lockRefreshMillis)),
        Effect.forever,
        Effect.forkScoped
      )

      const poll = (size: number) =>
        take(
          queueKey,
          pendingKey,
          prefix,
          workerId,
          size,
          lockExpirationMillis
        )

      yield* Effect.gen(function*() {
        while (true) {
          yield* pollLatch.await
          yield* Effect.yieldNow
          const results = takers.current === 0 ? null : yield* poll(takers.current)
          if (results === null) {
            yield* Effect.sleep(pollInterval)
            continue
          }
          takenLatch.closeUnsafe()
          yield* Queue.offerAll(queue, results.map((json) => JSON.parse(json)))
          yield* takenLatch.await
          yield* Effect.yieldNow
        }
      }).pipe(
        Effect.sandbox,
        Effect.retry(Schedule.spaced(500)),
        Effect.forkScoped,
        Effect.interruptible
      )

      return { queue, takers, pollLatch, takenLatch } as const
    }),
    idleTimeToLive: Duration.seconds(30)
  })

  const activeLockKeys = new Set<string>()

  yield* Effect.gen(function*() {
    while (true) {
      yield* Effect.sleep(lockRefreshMillis)
      yield* Effect.ignore(expireAll(Array.from(activeLockKeys), lockExpirationMillis))
    }
  }).pipe(
    Effect.forkScoped,
    Effect.interruptible,
    Effect.annotateLogs({
      module: "effect/persistence/PersistedQueue",
      fiber: "refreshLocks"
    })
  )

  return PersistedQueueStore.of({
    offer: ({ element, id, isCustomId, name }) =>
      Effect.mapError(
        isCustomId
          ? offer(
            `${prefix}${name}`,
            `${prefix}${name}:ids`,
            id,
            JSON.stringify({ id, element, attempts: 0 })
          )
          : redis.send("RPUSH", `${prefix}${name}`, JSON.stringify({ id, element, attempts: 0 })),
        ({ cause }) =>
          new PersistedQueueError({
            message: "Failed to offer element to persisted queue",
            cause
          })
      ),
    take: (options) =>
      Effect.uninterruptibleMask((restore) =>
        RcMap.get(queues, options.name).pipe(
          Effect.flatMap(({ pollLatch, queue, takenLatch, takers }) => {
            takers.current++
            if (takers.current === 1) {
              pollLatch.openUnsafe()
            }
            return Effect.tap(restore(Queue.take(queue)), () =>
              Effect.sync(() => {
                takers.current--
                if (takers.current === 0) {
                  pollLatch.closeUnsafe()
                  takenLatch.openUnsafe()
                } else if (Queue.sizeUnsafe(queue) === 0) {
                  takenLatch.openUnsafe()
                }
              }))
          }),
          Effect.scoped,
          Effect.tap((element) => {
            const lock = keyLock(element.id)
            activeLockKeys.add(lock)
            return Effect.addFinalizer(Exit.match({
              onFailure: (cause) => {
                activeLockKeys.delete(lock)
                const nextAttempts = element.attempts + 1
                if (nextAttempts >= options.maxAttempts) {
                  return Effect.orDie(failed(
                    keyPending(options.name),
                    lock,
                    keyFailed(options.name),
                    element.id,
                    JSON.stringify({
                      ...element,
                      lastFailure: Cause.pretty(cause),
                      attempts: nextAttempts
                    })
                  ))
                }
                return Effect.orDie(requeue(
                  keyQueue(options.name),
                  keyPending(options.name),
                  lock,
                  element.id,
                  JSON.stringify(
                    Cause.hasInterruptsOnly(cause)
                      ? element
                      : {
                        ...element,
                        lastFailure: Cause.pretty(cause),
                        attempts: nextAttempts
                      }
                  )
                ))
              },
              onSuccess: () => {
                activeLockKeys.delete(lock)
                return Effect.orDie(complete(
                  keyPending(options.name),
                  lock,
                  element.id
                ))
              }
            }))
          })
        )
      )
  })
})

const offerRedis = Redis.script(
  (...args: [keyQueue: string, keyIds: string, id: string, payload: string]) => args,
  {
    lua: `
local key_queue = KEYS[1]
local key_ids = KEYS[2]
local id = ARGV[1]
local payload = ARGV[2]

local result = redis.call("SADD", key_ids, id)
if result == 1 then
  redis.call("RPUSH", key_queue, payload)
end
`,
    numberOfKeys: 2
  }
)

const resetQueueRedis = Redis.script(
  (...args: [keyQueue: string, keyPending: string, prefix: string]) => args,
  {
    lua: `
local key_queue = KEYS[1]
local key_pending = KEYS[2]
local prefix = ARGV[1]

local entries = redis.call("HGETALL", key_pending)
for i = 1, #entries, 2 do
  local id = entries[i]
  local payload = entries[i + 1]
  local lock_key = prefix .. id .. ":lock"
  local exists = redis.call("EXISTS", lock_key)
  if exists == 0 then
    redis.call("RPUSH", key_queue, payload)
    redis.call("HDEL", key_pending, id)
  end
end
`,
    numberOfKeys: 2
  }
)

const requeueRedis = Redis.script(
  (...args: [keyQueue: string, keyPending: string, keyLock: string, id: string, payload: string]) => args,
  {
    lua: `
local key_queue = KEYS[1]
local key_pending = KEYS[2]
local key_lock = KEYS[3]
local id = ARGV[1]
local payload = ARGV[2]

redis.call("DEL", key_lock)
redis.call("HDEL", key_pending, id)
redis.call("RPUSH", key_queue, payload)
`,
    numberOfKeys: 3
  }
)

const completeRedis = Redis.script(
  (...args: [keyPending: string, keyLock: string, id: string]) => args,
  {
    lua: `
local key_pending = KEYS[1]
local key_lock = KEYS[2]
local id = ARGV[1]

redis.call("DEL", key_lock)
redis.call("HDEL", key_pending, id)
`,
    numberOfKeys: 2
  }
)

const failedRedis = Redis.script(
  (...args: [keyPending: string, keyLock: string, keyFailed: string, id: string, payload: string]) => args,
  {
    lua: `
local key_pending = KEYS[1]
local key_lock = KEYS[2]
local key_failed = KEYS[3]
local id = ARGV[1]
local payload = ARGV[2]

redis.call("DEL", key_lock)
redis.call("HDEL", key_pending, id)
redis.call("RPUSH", key_failed, payload)
`,
    numberOfKeys: 3
  }
)

const takeRedis = Redis.script(
  (
    ...args: [keyQueue: string, keyPending: string, prefix: string, workerId: string, batchSize: number, pttl: number]
  ) => args,
  {
    lua: `
local key_queue = KEYS[1]
local key_pending = KEYS[2]
local prefix = ARGV[1]
local worker_id = ARGV[2]
local batch_size = tonumber(ARGV[3])
local pttl = ARGV[4]

local payloads = redis.call("LPOP", key_queue, batch_size)
if not payloads then
  return nil
end

for i, payload in ipairs(payloads) do
  local id = cjson.decode(payload).id
  local key_lock = prefix .. id .. ":lock"
  redis.call("SET", key_lock, worker_id, "PX", pttl)
  redis.call("HSET", key_pending, id, payload)
end

return payloads
`,
    numberOfKeys: 2
  }
).withReturnType<Arr.NonEmptyArray<string> | null>()

const expireAllRedis = Redis.script(
  (keys: ReadonlyArray<string>, ttl: number) => [...keys, ttl],
  {
    numberOfKeys: (keys) => keys.length,
    lua: `
local ttl = ARGV[1]
for i, key in ipairs(KEYS) do
  redis.call("PEXPIRE", key, ttl)
end
`
  }
)

/**
 * Provides a Redis-backed `PersistedQueueStore` using `makeStoreRedis`.
 *
 * @category store
 * @since 4.0.0
 */
export const layerStoreRedis: (
  options?: {
    readonly prefix?: string | undefined
    readonly pollInterval?: Duration.Input | undefined
    readonly lockRefreshInterval?: Duration.Input | undefined
    readonly lockExpiration?: Duration.Input | undefined
  } | undefined
) => Layer.Layer<
  PersistedQueueStore,
  never,
  Redis.Redis
> = flow(makeStoreRedis, Layer.effect(PersistedQueueStore))

/**
 * Creates a SQL-backed `PersistedQueueStore`.
 *
 * **Details**
 *
 * The store creates the queue table and indexes, acquires rows with
 * per-worker locks, refreshes active locks while scoped takes are running, and
 * retries or completes rows according to the processing exit.
 *
 * @category store
 * @since 4.0.0
 */
export const makeStoreSql: (
  options?: {
    readonly tableName?: string | undefined
    readonly pollInterval?: Duration.Input | undefined
    readonly lockRefreshInterval?: Duration.Input | undefined
    readonly lockExpiration?: Duration.Input | undefined
  } | undefined
) => Effect.Effect<
  PersistedQueueStore["Service"],
  SqlError,
  SqlClient.SqlClient | Scope.Scope
> = Effect.fnUntraced(function*(options) {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms()
  const tableName = options?.tableName ?? "effect_queue"
  const tableNameSql = sql(tableName)
  const pollInterval = Duration.max(
    options?.pollInterval ? Duration.fromInputUnsafe(options.pollInterval) : Duration.millis(1000),
    Duration.millis(1)
  )
  const lockRefreshInterval = Duration.max(
    options?.lockRefreshInterval ? Duration.fromInputUnsafe(options.lockRefreshInterval) : Duration.seconds(30),
    Duration.millis(1)
  )
  const lockExpiration = Duration.max(
    options?.lockExpiration ? Duration.fromInputUnsafe(options.lockExpiration) : Duration.minutes(2),
    Duration.millis(1)
  )
  const lockExpirationSql = sql.literal(Math.ceil(Duration.toSeconds(lockExpiration)).toString())
  const workerId = crypto.randomUUID()

  const sqlNow = sql.onDialectOrElse({
    mssql: () => sql.literal("GETDATE()"),
    mysql: () => sql.literal("NOW()"),
    pg: () => sql.literal("NOW()"),
    // sqlite
    orElse: () => sql.literal("CURRENT_TIMESTAMP")
  })

  const expiresAt = sql.onDialectOrElse({
    pg: () => sql`${sqlNow} - INTERVAL '${lockExpirationSql} seconds'`,
    mysql: () => sql`DATE_SUB(${sqlNow}, INTERVAL ${lockExpirationSql} SECOND)`,
    mssql: () => sql`DATEADD(SECOND, -${lockExpirationSql}, ${sqlNow})`,
    orElse: () => sql`datetime(${sqlNow}, '-${lockExpirationSql} seconds')`
  })

  yield* sql.onDialectOrElse({
    mysql: () =>
      sql`CREATE TABLE IF NOT EXISTS ${tableNameSql} (
        sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        id VARCHAR(36) NOT NULL,
        queue_name VARCHAR(100) NOT NULL,
        element TEXT NOT NULL,
        completed BOOLEAN NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_failure TEXT NULL,
        acquired_at DATETIME NULL,
        acquired_by VARCHAR(36) NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )`,
    pg: () =>
      sql`CREATE TABLE IF NOT EXISTS ${tableNameSql} (
        sequence SERIAL PRIMARY KEY,
        id VARCHAR(36) NOT NULL,
        queue_name VARCHAR(100) NOT NULL,
        element TEXT NOT NULL,
        completed BOOLEAN NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_failure TEXT NULL,
        acquired_at TIMESTAMP NULL,
        acquired_by UUID NULL,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL
      )`,
    mssql: () =>
      sql`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name=${tableNameSql} AND xtype='U')
      CREATE TABLE ${tableNameSql} (
        sequence INT IDENTITY(1,1) PRIMARY KEY,
        id NVARCHAR(36) NOT NULL,
        queue_name NVARCHAR(100) NOT NULL,
        element NVARCHAR(MAX) NOT NULL,
        completed BIT NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_failure NVARCHAR(MAX) NULL,
        acquired_at DATETIME2 NULL,
        acquired_by UNIQUEIDENTIFIER NULL,
        created_at DATETIME2 NOT NULL,
        updated_at DATETIME2 NOT NULL
      )`,
    // sqlite
    orElse: () =>
      sql`CREATE TABLE IF NOT EXISTS ${tableNameSql} (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        queue_name TEXT NOT NULL,
        element TEXT NOT NULL,
        completed BOOLEAN NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_failure TEXT NULL,
        acquired_at DATETIME NULL,
        acquired_by TEXT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )`
  })

  yield* sql.onDialectOrElse({
    mssql: () =>
      sql`IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = N'idx_${tableName}_id')
        CREATE UNIQUE INDEX idx_${tableNameSql}_id ON ${tableNameSql} (id)`,
    mysql: () => sql`CREATE UNIQUE INDEX ${sql(`idx_${tableName}_id`)} ON ${tableNameSql} (id)`.pipe(Effect.ignore),
    orElse: () => sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql(`idx_${tableName}_id`)} ON ${tableNameSql} (id)`
  })

  yield* sql.onDialectOrElse({
    mssql: () =>
      sql`IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = N'idx_${tableName}_take')
        CREATE INDEX idx_${tableNameSql}_take ON ${tableNameSql} (queue_name, completed, attempts, acquired_at)`,
    mysql: () =>
      sql`CREATE INDEX ${
        sql(`idx_${tableName}_take`)
      } ON ${tableNameSql} (queue_name, completed, attempts, acquired_at)`
        .pipe(Effect.ignore),
    orElse: () =>
      sql`CREATE INDEX IF NOT EXISTS ${
        sql(`idx_${tableName}_take`)
      } ON ${tableNameSql} (queue_name, completed, attempts, acquired_at)`
  })

  yield* sql.onDialectOrElse({
    mssql: () =>
      sql`IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = N'idx_${tableName}_update')
        CREATE INDEX ${sql(`idx_${tableName}_update`)} ON ${tableNameSql} (sequence, acquired_by)`,
    mysql: () =>
      sql`CREATE INDEX ${sql(`idx_${tableName}_update`)} ON ${tableNameSql} (sequence, acquired_by)`.pipe(
        Effect.ignore
      ),
    orElse: () =>
      sql`CREATE INDEX IF NOT EXISTS ${sql(`idx_${tableName}_update`)} ON ${tableNameSql} (sequence, acquired_by)`
  })

  const offer = sql.onDialectOrElse({
    pg: () => (id: string, name: string, element: string) =>
      sql`
        INSERT INTO ${tableNameSql} (id, queue_name, element, completed, attempts, created_at, updated_at)
        VALUES (${id}, ${name}, ${element}, FALSE, 0, ${sqlNow}, ${sqlNow})
        ON CONFLICT (id) DO NOTHING
      `,
    mysql: () => (id: string, name: string, element: string) =>
      sql`
        INSERT IGNORE INTO ${tableNameSql} (id, queue_name, element, completed, attempts, created_at, updated_at)
        VALUES (${id}, ${name}, ${element}, FALSE, 0, ${sqlNow}, ${sqlNow})
      `,
    mssql: () => (id: string, name: string, element: string) =>
      sql`
        IF NOT EXISTS (SELECT 1 FROM ${tableNameSql} WHERE id = ${id})
        BEGIN
          INSERT INTO ${tableNameSql} (id, queue_name, element, completed, attempts, created_at, updated_at)
          VALUES (${id}, ${name}, ${element}, 0, 0, ${sqlNow}, ${sqlNow})
        END
      `,
    // sqlite
    orElse: () => (id: string, name: string, element: string) =>
      sql`
        INSERT OR IGNORE INTO ${tableNameSql} (id, queue_name, element, completed, attempts, created_at, updated_at)
        VALUES (${id}, ${name}, ${element}, FALSE, 0, ${sqlNow}, ${sqlNow})
      `
  })

  const wrapString = sql.onDialectOrElse({
    mssql: () => (s: string) => `N'${s}'`,
    orElse: () => (s: string) => `'${s}'`
  })
  const stringLiteral = (s: string) => sql.literal(wrapString(s))

  const sqlTrue = sql.onDialectOrElse({
    sqlite: () => sql.literal("1"),
    orElse: () => sql.literal("TRUE")
  })

  const workerIdSql = stringLiteral(workerId)
  const elementIds = new Set<number>()
  const refreshLocks: Effect.Effect<void, SqlError> = Effect.suspend((): Effect.Effect<void, SqlError> => {
    if (elementIds.size === 0) return Effect.void
    const ids = Array.from(elementIds)
    return sql`
      UPDATE ${tableNameSql}
      SET acquired_at = ${sqlNow}
      WHERE sequence IN (${sql.literal(ids.join(","))})
      AND acquired_by = ${workerIdSql}
    `
  })
  const complete = (sequence: number, attempts: number) => {
    elementIds.delete(sequence)
    return sql`
      UPDATE ${tableNameSql}
      SET acquired_at = NULL, acquired_by = NULL, updated_at = ${sqlNow}, completed = ${sqlTrue}, attempts = ${attempts}
      WHERE sequence = ${sequence}
      AND acquired_by = ${workerIdSql}
    `.pipe(
      Effect.retry({
        times: 5,
        schedule: Schedule.exponential(100, 1.5)
      }),
      Effect.orDie
    )
  }
  const retry = (sequence: number, attempts: number, cause: Cause.Cause<any>) => {
    elementIds.delete(sequence)
    return sql`
      UPDATE ${tableNameSql}
      SET acquired_at = NULL, acquired_by = NULL, updated_at = ${sqlNow}, attempts = ${attempts}, last_failure = ${
      Cause.pretty(cause)
    }
      WHERE sequence = ${sequence}
      AND acquired_by = ${workerIdSql}
    `.pipe(
      Effect.retry({
        times: 5,
        schedule: Schedule.exponential(100, 1.5)
      }),
      Effect.orDie
    )
  }
  const interrupt = (ids: Array<number>) => {
    for (const id of ids) {
      elementIds.delete(id)
    }
    return sql`
      UPDATE ${tableNameSql}
      SET acquired_at = NULL, acquired_by = NULL
      WHERE sequence IN (${sql.literal(ids.join(","))})
      AND acquired_by = ${workerIdSql}
    `.pipe(
      Effect.retry({
        times: 5,
        schedule: Schedule.exponential(100, 1.5)
      }),
      Effect.orDie
    )
  }

  yield* refreshLocks.pipe(
    Effect.tapCause(Effect.logWarning),
    Effect.retry(Schedule.spaced(500)),
    Effect.schedule(Schedule.fixed(lockRefreshInterval)),
    Effect.annotateLogs({
      package: "@effect/sql",
      module: "SqlPersistedQueue",
      fiber: "refreshLocks"
    }),
    Effect.forkScoped
  )

  type Element = {
    readonly id: string
    sequence: number
    readonly queue_name: string
    element: string
    readonly attempts: number
  }
  const mailboxes = yield* RcMap.make({
    lookup: Effect.fnUntraced(function*({ maxAttempts, name }: QueueKey) {
      const queue = yield* Queue.make<Element>()
      const takers = MutableRef.make(0)
      const pollLatch = Latch.makeUnsafe()
      const takenLatch = Latch.makeUnsafe()

      yield* Effect.addFinalizer(() =>
        Effect.flatMap(Queue.clear(queue), (elements) => {
          if (elements.length === 0) return Effect.void
          return interrupt(Array.from(elements, (e) => e.sequence))
        })
      )

      const poll = sql.onDialectOrElse({
        pg: () => (size: number) =>
          sql<Element>`
            WITH cte AS (
              UPDATE ${tableNameSql}
              SET acquired_at = ${sqlNow}, acquired_by = ${workerIdSql}
              WHERE sequence IN (
                SELECT sequence FROM ${tableNameSql}
                WHERE queue_name = ${name}
                AND completed = FALSE
                AND attempts < ${maxAttempts}
                AND (acquired_at IS NULL OR acquired_at < ${expiresAt})
                ORDER BY updated_at ASC, sequence ASC
                FOR UPDATE SKIP LOCKED
                LIMIT ${sql.literal(size.toString())}
              )
              RETURNING sequence, id, queue_name, element, attempts, updated_at
            )
            SELECT sequence, id, queue_name, element, attempts FROM cte
            ORDER BY updated_at ASC, sequence ASC
          `,
        mysql: () => (size: number) =>
          sql<Element>`
            SELECT sequence, id, queue_name, element, attempts FROM ${tableNameSql} q
            WHERE queue_name = ${name}
            AND completed = FALSE
            AND attempts < ${maxAttempts}
            AND (acquired_at IS NULL OR acquired_at < ${expiresAt})
            ORDER BY updated_at ASC, sequence ASC
            LIMIT ${sql.literal(size.toString())}
            FOR UPDATE SKIP LOCKED
          `.pipe(
            Effect.tap((rows) => {
              if (rows.length === 0) return Effect.void
              return sql`
                UPDATE ${tableNameSql}
                SET acquired_at = ${sqlNow}, acquired_by = ${workerIdSql}
                WHERE sequence IN (${sql.literal(rows.map((r) => r.sequence).join(","))})
              `.unprepared
            }),
            sql.withTransaction
          ),
        mssql: () => (size: number) =>
          sql<Element>`
            WITH cte AS (
              SELECT TOP ${sql.literal(size.toString())} sequence FROM ${tableNameSql}
              WHERE queue_name = ${name}
              AND completed = 0
              AND attempts < ${maxAttempts}
              AND (acquired_at IS NULL OR acquired_at < ${expiresAt})
              ORDER BY updated_at ASC, sequence ASC
            )
            UPDATE q
            SET acquired_at = ${sqlNow}, acquired_by = ${workerIdSql}
            OUTPUT inserted.sequence, inserted.id, inserted.queue_name, inserted.element, inserted.attempts
            FROM ${tableNameSql} AS q
            INNER JOIN cte ON q.sequence = cte.sequence
          `,
        // sqlite
        orElse: () => (size: number) =>
          sql<Element>`
            UPDATE ${tableNameSql}
            SET acquired_at = ${sqlNow}, acquired_by = ${workerIdSql}
            WHERE queue_name = ${name}
            AND completed = FALSE
            AND attempts < ${maxAttempts}
            AND (acquired_at IS NULL OR acquired_at < ${expiresAt})
            RETURNING sequence, id, queue_name, element, attempts
            ORDER BY updated_at ASC, sequence ASC
            LIMIT ${sql.literal(size.toString())}
          `
      })

      yield* Effect.gen(function*() {
        while (true) {
          yield* pollLatch.await
          yield* Effect.yieldNow
          const results = takers.current === 0 ? [] : yield* poll(takers.current)
          if (results.length === 0) {
            yield* Effect.sleep(pollInterval)
            continue
          }
          takenLatch.closeUnsafe()
          for (let i = 0; i < results.length; i++) {
            const element = results[i]
            elementIds.add(element.sequence)
          }
          yield* Queue.offerAll(queue, results)
          yield* takenLatch.await
          yield* Effect.yieldNow
        }
      }).pipe(
        Effect.sandbox,
        Effect.retry(Schedule.spaced(500)),
        Effect.forkScoped
      )

      return { queue, takers, pollLatch, takenLatch } as const
    }),
    idleTimeToLive: Duration.seconds(30)
  })

  return PersistedQueueStore.of({
    offer: ({ element, id, name }) =>
      Effect.catchCause(Effect.suspend(() => offer(id, name, JSON.stringify(element))), (cause) =>
        Effect.fail(
          new PersistedQueueError({
            message: "Failed to offer element to persisted queue",
            cause
          })
        )),
    take: ({ maxAttempts, name }) =>
      Effect.uninterruptibleMask((restore) =>
        RcMap.get(mailboxes, new QueueKey({ name, maxAttempts })).pipe(
          Effect.flatMap(({ pollLatch, queue, takenLatch, takers }) => {
            takers.current++
            if (takers.current === 1) {
              pollLatch.openUnsafe()
            }
            return Effect.tap(restore(Queue.take(queue)), () =>
              Effect.sync(() => {
                takers.current--
                if (takers.current === 0) {
                  pollLatch.closeUnsafe()
                  takenLatch.openUnsafe()
                } else if (Queue.sizeUnsafe(queue) === 0) {
                  takenLatch.openUnsafe()
                }
              }))
          }),
          Effect.scoped,
          restore,
          Effect.tap((element) =>
            Effect.addFinalizer(Exit.match({
              onFailure: (cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? interrupt([element.sequence])
                  : retry(element.sequence, element.attempts + 1, cause),
              onSuccess: () => complete(element.sequence, element.attempts + 1)
            }))
          ),
          Effect.map((element) => ({
            ...element,
            element: JSON.parse(element.element)
          }))
        )
      )
  })
})

class QueueKey extends Data.Class<{
  readonly name: string
  readonly maxAttempts: number
}> {}

/**
 * Provides a SQL-backed `PersistedQueueStore` using `makeStoreSql`.
 *
 * @category store
 * @since 4.0.0
 */
export const layerStoreSql: (
  options?: {
    readonly tableName?: string | undefined
    readonly pollInterval?: Duration.Input | undefined
    readonly lockRefreshInterval?: Duration.Input | undefined
    readonly lockExpiration?: Duration.Input | undefined
  } | undefined
) => Layer.Layer<
  PersistedQueueStore,
  SqlError,
  SqlClient.SqlClient
> = flow(makeStoreSql, Layer.effect(PersistedQueueStore))
