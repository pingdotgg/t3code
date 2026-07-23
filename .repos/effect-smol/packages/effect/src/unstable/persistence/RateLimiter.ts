/**
 * Persistent rate limiting for effects that need to coordinate token
 * consumption through a shared `RateLimiterStore`.
 *
 * The module exposes a `RateLimiter` service that can consume tokens for
 * string keys using either fixed-window counters or token-bucket state. It is
 * useful for protecting external APIs, enforcing per-user or per-tenant quotas,
 * throttling job workers, and coordinating limits across multiple fibers or
 * processes when they share the Redis-backed store. The helpers can fail fast
 * with `RateLimiterError`, return a delay to apply yourself, or wrap an effect
 * so it waits before continuing.
 *
 * Rate-limit keys and Redis prefixes are part of the persistence namespace, so
 * choose stable, collision-free values. The in-memory store is process-local
 * and is only coordinated inside one runtime, while the Redis store uses Lua
 * scripts for atomic updates under concurrent consumers. Time is measured with
 * the Effect `Clock`, windows are clamped to at least one millisecond, and
 * refill calculations use millisecond granularity.
 *
 * Fixed-window state is TTL-driven: rejected `fail` attempts do not extend the
 * current TTL, and Redis fixed-window keys expire automatically. Token-bucket
 * state keeps the remaining token count and last-refill time instead of using a
 * TTL, so high-cardinality dynamic keys may need an external cleanup or bounded
 * key strategy. With `onExceeded: "delay"`, overflow can be recorded so callers
 * should actually sleep for the returned delay, or use the provided accessors.
 *
 * @since 4.0.0
 */
import * as Config from "../../Config.ts"
import * as Context from "../../Context.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import { flow, identity } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Schema from "../../Schema.ts"
import * as Redis from "./Redis.ts"

/**
 * Runtime type identifier for `RateLimiter` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~effect/persistence/RateLimiter"

/**
 * Type-level identifier used to brand `RateLimiter` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~effect/persistence/RateLimiter"

/**
 * Service for consuming rate-limit tokens for a key using fixed-window or
 * token-bucket algorithms.
 *
 * @category models
 * @since 4.0.0
 */
export interface RateLimiter {
  readonly [TypeId]: TypeId

  readonly consume: (options: {
    readonly algorithm?: "fixed-window" | "token-bucket" | undefined
    readonly onExceeded?: "delay" | "fail" | undefined
    readonly window: Duration.Input
    readonly limit: number
    readonly key: string
    readonly tokens?: number | undefined
  }) => Effect.Effect<ConsumeResult, RateLimiterError>
}

/**
 * Service tag for persistent token-consumption services.
 *
 * **When to use**
 *
 * Use to access or provide rate-limit checks backed by fixed-window counters or
 * token-bucket state.
 *
 * @category tags
 * @since 4.0.0
 */
export const RateLimiter: Context.Service<RateLimiter, RateLimiter> = Context.Service<RateLimiter>(TypeId)

/**
 * Creates a `RateLimiter` from the current `RateLimiterStore`.
 *
 * **Details**
 *
 * The limiter supports fixed-window and token-bucket algorithms and either
 * fails or returns a delay when a limit is exceeded.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: Effect.Effect<
  RateLimiter,
  never,
  RateLimiterStore
> = Effect.gen(function*() {
  const store = yield* RateLimiterStore

  return identity<RateLimiter>({
    [TypeId]: TypeId,
    consume(options) {
      const tokens = options.tokens ?? 1
      const onExceeded = options.onExceeded ?? "fail"
      const algorithm = options.algorithm ?? "fixed-window"
      const window = Duration.max(Duration.fromInputUnsafe(options.window), Duration.millis(1))
      const windowMillis = Duration.toMillis(window)
      const refillRate = Duration.divideUnsafe(window, options.limit)
      const refillRateMillis = Duration.toMillis(refillRate)

      if (tokens > options.limit) {
        return onExceeded === "fail"
          ? Effect.fail(
            new RateLimiterError({
              reason: new RateLimitExceeded({
                key: options.key,
                retryAfter: window,
                limit: options.limit,
                remaining: 0
              })
            })
          )
          : Effect.succeed<ConsumeResult>({
            delay: window,
            limit: options.limit,
            remaining: 0,
            resetAfter: window
          })
      }

      if (algorithm === "fixed-window") {
        return Effect.flatMap(
          store.fixedWindow({
            key: options.key,
            tokens,
            refillRate,
            limit: onExceeded === "fail" ? options.limit : undefined
          }),
          ([count, ttl]) => {
            if (onExceeded === "fail") {
              const remaining = options.limit - count
              if (remaining < 0) {
                return Effect.fail(
                  new RateLimiterError({
                    reason: new RateLimitExceeded({
                      key: options.key,
                      retryAfter: Duration.millis(ttl),
                      limit: options.limit,
                      remaining: 0
                    })
                  })
                )
              }
              return Effect.succeed<ConsumeResult>({
                delay: Duration.zero,
                limit: options.limit,
                remaining,
                resetAfter: Duration.millis(ttl)
              })
            }
            const ttlTotal = count * refillRateMillis
            const elapsed = ttlTotal - ttl
            const windowNumber = Math.floor((count - 1) / options.limit)
            const remaining = (windowNumber * windowMillis) - elapsed
            const delay = remaining <= 0 ? Duration.zero : Duration.millis(remaining)
            return Effect.succeed<ConsumeResult>({
              delay,
              limit: options.limit,
              remaining: options.limit - count,
              resetAfter: Duration.times(window, Math.ceil(ttl / windowMillis))
            })
          }
        )
      }

      return Effect.flatMap(
        store.tokenBucket({
          key: options.key,
          tokens,
          limit: options.limit,
          refillRate,
          allowOverflow: onExceeded === "delay"
        }),
        (remaining) => {
          if (onExceeded === "fail") {
            if (remaining < 0) {
              return Effect.fail(
                new RateLimiterError({
                  reason: new RateLimitExceeded({
                    key: options.key,
                    retryAfter: Duration.times(refillRate, -remaining),
                    limit: options.limit,
                    remaining: 0
                  })
                })
              )
            }
            return Effect.succeed<ConsumeResult>({
              delay: Duration.zero,
              limit: options.limit,
              remaining,
              resetAfter: Duration.times(refillRate, options.limit - remaining)
            })
          }
          if (remaining >= 0) {
            return Effect.succeed<ConsumeResult>({
              delay: Duration.zero,
              limit: options.limit,
              remaining,
              resetAfter: Duration.times(refillRate, options.limit - remaining)
            })
          }
          return Effect.succeed<ConsumeResult>({
            delay: Duration.times(refillRate, -remaining),
            limit: options.limit,
            remaining,
            resetAfter: Duration.times(refillRate, options.limit - remaining)
          })
        }
      )
    }
  })
})

/**
 * Provides `RateLimiter` using the current `RateLimiterStore`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<
  RateLimiter,
  never,
  RateLimiterStore
> = Layer.effect(RateLimiter, make)

/**
 * Accesses a function that applies rate limiting to an effect.
 *
 * **Example** (Applying rate limits to effects)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { RateLimiter } from "effect/unstable/persistence"
 *
 * Effect.gen(function*() {
 *   // Access the `withLimiter` function from the RateLimiter module
 *   const withLimiter = yield* RateLimiter.makeWithRateLimiter
 *
 *   // Apply a rate limiter to an effect
 *   yield* Effect.log("Making a request with rate limiting").pipe(
 *     withLimiter({
 *       key: "some-key",
 *       limit: 10,
 *       onExceeded: "delay",
 *       window: "5 seconds",
 *       algorithm: "fixed-window"
 *     })
 *   )
 * })
 * ```
 *
 * @category accessors
 * @since 4.0.0
 */
export const makeWithRateLimiter: Effect.Effect<
  ((options: {
    readonly algorithm?: "fixed-window" | "token-bucket" | undefined
    readonly onExceeded?: "delay" | "fail" | undefined
    readonly window: Duration.Input
    readonly limit: number
    readonly key: string
    readonly tokens?: number | undefined
  }) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | RateLimiterError, R>),
  never,
  RateLimiter
> = RateLimiter.use((limiter) =>
  Effect.succeed((options) => (effect) =>
    Effect.flatMap(limiter.consume(options), ({ delay }) => {
      if (Duration.isZero(delay)) return effect
      return Effect.delay(effect, delay)
    })
  )
)

/**
 * Accesses a function that sleeps when the rate limit is exceeded.
 *
 * **Example** (Sleeping until rate limit permits)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { RateLimiter } from "effect/unstable/persistence"
 *
 * Effect.gen(function*() {
 *   // Access the `sleep` function from the RateLimiter module
 *   const sleep = yield* RateLimiter.makeSleep
 *
 *   // Use the `sleep` function with specific rate limiting parameters.
 *   // This will only sleep if the rate limit has been exceeded.
 *   yield* sleep({
 *     key: "some-key",
 *     limit: 10,
 *     window: "5 seconds",
 *     algorithm: "fixed-window"
 *   })
 * })
 * ```
 *
 * @category accessors
 * @since 4.0.0
 */
export const makeSleep: Effect.Effect<
  ((options: {
    readonly algorithm?: "fixed-window" | "token-bucket" | undefined
    readonly window: Duration.Input
    readonly limit: number
    readonly key: string
    readonly tokens?: number | undefined
  }) => Effect.Effect<ConsumeResult, RateLimiterError>),
  never,
  RateLimiter
> = RateLimiter.use((limiter) =>
  Effect.succeed((options) =>
    Effect.flatMap(
      limiter.consume({
        ...options,
        onExceeded: "delay"
      }),
      (result) => {
        if (Duration.isZero(result.delay)) return Effect.succeed(result)
        return Effect.as(Effect.sleep(result.delay), result)
      }
    )
  )
)

/**
 * Runtime type identifier for `RateLimiterError`.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const ErrorTypeId: ErrorTypeId = "~@effect/experimental/RateLimiter/RateLimiterError"

/**
 * Type-level identifier used to brand `RateLimiterError` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type ErrorTypeId = "~@effect/experimental/RateLimiter/RateLimiterError"

/**
 * Error reason for a rate-limit check that exceeded the configured limit.
 *
 * **Details**
 *
 * Includes the affected key, limit, remaining token count, and retry delay.
 *
 * @category errors
 * @since 4.0.0
 */
export class RateLimitExceeded extends Schema.ErrorClass<RateLimitExceeded>(
  "effect/persistence/RateLimiter/RateLimitExceeded"
)({
  _tag: Schema.tag("RateLimitExceeded"),
  retryAfter: Schema.DurationFromMillis,
  key: Schema.String,
  limit: Schema.Number,
  remaining: Schema.Number
}) {
  /**
   * Public message used when the rate limiter rejects a request.
   *
   * @since 4.0.0
   */
  override get message(): string {
    return `Rate limit exceeded`
  }
}

/**
 * Error reason for failures in the backing `RateLimiterStore`.
 *
 * @category errors
 * @since 4.0.0
 */
export class RateLimitStoreError extends Schema.ErrorClass<RateLimitStoreError>(
  "effect/persistence/RateLimiter/RateLimitStoreError"
)({
  _tag: Schema.tag("RateLimitStoreError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * Union of reasons carried by `RateLimiterError`.
 *
 * @category errors
 * @since 4.0.0
 */
export type RateLimiterErrorReason = RateLimitExceeded | RateLimitStoreError

/**
 * Schema for all reasons that can be carried by `RateLimiterError`.
 *
 * @category errors
 * @since 4.0.0
 */
export const RateLimiterErrorReason: Schema.Union<[
  typeof RateLimitExceeded,
  typeof RateLimitStoreError
]> = Schema.Union([RateLimitExceeded, RateLimitStoreError])

/**
 * Error raised by rate limiter operations, wrapping a concrete failure
 * `reason`.
 *
 * @category errors
 * @since 4.0.0
 */
export class RateLimiterError extends Schema.ErrorClass<RateLimiterError>(ErrorTypeId)({
  _tag: Schema.tag("RateLimiterError"),
  reason: RateLimiterErrorReason
}) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly reason: RateLimiterErrorReason
  }) {
    if ("cause" in props.reason) {
      super({
        ...props,
        cause: props.reason.cause
      } as any)
    } else {
      super(props)
    }
  }

  /**
   * Marks this value as a rate limiter error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ErrorTypeId]: ErrorTypeId = ErrorTypeId

  override get message(): string {
    return this.reason.message
  }
}

/**
 * Metadata returned after consuming tokens from a rate limiter.
 *
 * @category models
 * @since 4.0.0
 */
export interface ConsumeResult {
  /**
   * The amount of delay to wait before making the next request, when the rate
   * limiter is using the "delay" `onExceeded` strategy. It will be
   * Duration.zero if the request is allowed immediately.
   */
  readonly delay: Duration.Duration

  /**
   * The maximum number of requests allowed in the current window.
   */
  readonly limit: number

  /**
   * The number of remaining requests in the current window.
   */
  readonly remaining: number

  /**
   * The time until the rate limit fully resets.
   */
  readonly resetAfter: Duration.Duration
}

/**
 * Defines the low-level backing store for fixed-window counters and token-bucket state.
 *
 * **When to use**
 *
 * Use to provide the shared counter storage used by persistent rate-limit
 * checks.
 *
 * @category store
 * @since 4.0.0
 */
export class RateLimiterStore extends Context.Service<
  RateLimiterStore,
  {
    /**
     * Returns the token count *after* taking the specified `tokens` and time to
     * live for the `key`.
     *
     * If `limit` is provided, the number of taken tokens will be capped at the
     * limit.
     *
     * In the case the limit is exceeded, the returned count will be greater
     * than the limit, but the TTL will not be updated.
     */
    readonly fixedWindow: (options: {
      readonly key: string
      readonly tokens: number
      readonly refillRate: Duration.Duration
      readonly limit: number | undefined
    }) => Effect.Effect<readonly [count: number, ttl: number], RateLimiterError>

    /**
     * Returns the current remaining tokens for the `key` after consuming the
     * specified amount of tokens.
     *
     * If `allowOverflow` is true, the number of tokens can drop below zero.
     *
     * In the case of no overflow, the returned token count will only be
     * negative if the requested tokens exceed the available tokens, but the
     * real token count will not be persisted below zero.
     */
    readonly tokenBucket: (options: {
      readonly key: string
      readonly tokens: number
      readonly limit: number
      readonly refillRate: Duration.Duration
      readonly allowOverflow: boolean
    }) => Effect.Effect<number, RateLimiterError>
  }
>()("effect/persistence/RateLimiter/RateLimiterStore") {}

/**
 * Provides a process-local in-memory `RateLimiterStore`.
 *
 * @category RateLimiterStore
 * @since 4.0.0
 */
export const layerStoreMemory: Layer.Layer<
  RateLimiterStore
> = Layer.sync(RateLimiterStore, () => {
  const fixedCounters = new Map<string, { count: number; expiresAt: number }>()
  const tokenBuckets = new Map<string, { tokens: number; lastRefill: number }>()

  return RateLimiterStore.of({
    fixedWindow: (options) =>
      Effect.clockWith((clock) =>
        Effect.sync(() => {
          const refillRateMillis = Duration.toMillis(options.refillRate)
          const now = clock.currentTimeMillisUnsafe()
          let counter = fixedCounters.get(options.key)
          if (!counter || counter.expiresAt <= now) {
            counter = { count: 0, expiresAt: now }
            fixedCounters.set(options.key, counter)
          }
          if (options.limit && counter.count + options.tokens > options.limit) {
            return [counter.count + options.tokens, counter.expiresAt - now] as const
          }
          counter.count += options.tokens
          counter.expiresAt += refillRateMillis * options.tokens
          return [counter.count, counter.expiresAt - now] as const
        })
      ),
    tokenBucket: (options) =>
      Effect.clockWith((clock) =>
        Effect.sync(() => {
          const refillRateMillis = Duration.toMillis(options.refillRate)
          const now = clock.currentTimeMillisUnsafe()
          let bucket = tokenBuckets.get(options.key)
          if (!bucket) {
            bucket = { tokens: options.limit, lastRefill: now }
            tokenBuckets.set(options.key, bucket)
          } else {
            const elapsed = now - bucket.lastRefill
            const tokensToAdd = Math.floor(elapsed / refillRateMillis)
            if (tokensToAdd > 0) {
              bucket.tokens = Math.min(options.limit, bucket.tokens + tokensToAdd)
              bucket.lastRefill += tokensToAdd * refillRateMillis
            }
          }

          const newTokenCount = bucket.tokens - options.tokens
          if (options.allowOverflow || newTokenCount >= 0) {
            bucket.tokens = newTokenCount
          }
          return newTokenCount
        })
      )
  })
})

/**
 * Creates a Redis-backed `RateLimiterStore` using Lua scripts and the
 * configured key prefix.
 *
 * @category RateLimiterStore
 * @since 4.0.0
 */
export const makeStoreRedis = Effect.fnUntraced(function*(
  options?: {
    readonly prefix?: string | undefined
  }
) {
  const prefix = options?.prefix ?? "ratelimiter:"
  const redis = yield* Redis.Redis

  const fixedWindow = redis.eval(fixedWindowScript)
  const tokenBucket = redis.eval(tokenBucketScript)

  return RateLimiterStore.of({
    fixedWindow(options) {
      const key = `${prefix}${options.key}`
      const refillMillis = Duration.toMillis(options.refillRate)
      return Effect.mapError(
        fixedWindow(key, options.tokens, refillMillis, options.limit),
        (cause) =>
          new RateLimiterError({
            reason: new RateLimitStoreError({
              message: `Failed to execute fixedWindow rate limiting command`,
              cause: cause.cause
            })
          })
      )
    },
    tokenBucket(options) {
      const key = `${prefix}${options.key}`
      const refillMillis = Duration.toMillis(options.refillRate)
      return Effect.clockWith((clock) =>
        Effect.mapError(
          tokenBucket(
            key,
            options.tokens,
            refillMillis,
            options.limit,
            clock.currentTimeMillisUnsafe(),
            options.allowOverflow ? 1 : 0
          ),
          (cause) =>
            new RateLimiterError({
              reason: new RateLimitStoreError({
                message: `Failed to execute tokenBucket rate limiting command`,
                cause
              })
            })
        )
      )
    }
  })
})

const fixedWindowScript = Redis.script(
  (key: string, tokens: number, refillMillis: number, limit?: number) => [key, tokens, refillMillis, limit],
  {
    numberOfKeys: 1,
    lua: `
local key = KEYS[1]
local tokens = tonumber(ARGV[1])
local refillms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local current = tonumber(redis.call("GET", key))

if not current then
  local nextpttl = refillms * tokens
  redis.call("SET", key, tokens, "PX", nextpttl)
  return { tokens, nextpttl }
end

local currentpttl = tonumber(redis.call("PTTL", key) or "0")
local next = current + tokens
if limit and next > limit then
  return { next, currentpttl }
end

local nextpttl = currentpttl + (refillms * tokens)
redis.call("SET", key, next, "PX", nextpttl)
return { next, nextpttl }
`
  }
).withReturnType<readonly [currentTokens: number, nextPttl: number]>()

const tokenBucketScript = Redis.script(
  (
    key: string,
    tokens: number,
    refillMillis: number,
    limit: number,
    now: number,
    overflow: 0 | 1
  ) => [key, tokens, refillMillis, limit, now, overflow],
  {
    numberOfKeys: 1,
    lua: `
local key = KEYS[1]
local last_refill_key = key .. ":refill"
local tokens = tonumber(ARGV[1])
local refill_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local overflow = ARGV[5] == "1"
local current = tonumber(redis.call("GET", key))
local last_refill = tonumber(redis.call("GET", last_refill_key))

if not current then
  current = limit
  last_refill = now
  redis.call("SET", key, current)
  redis.call("SET", last_refill_key, last_refill)
end

local elapsed = now - last_refill
local refill_amount = math.floor(elapsed / refill_ms)
if refill_amount > 0 then
  current = math.min(current + refill_amount, limit)
  last_refill = last_refill + (refill_amount * refill_ms)
  redis.call("SET", last_refill_key, last_refill)
end

local next = current - tokens
if next < 0 and not overflow then
  redis.call("SET", key, current)
  return next
end

redis.call("SET", key, next)
return next
`
  }
).withReturnType<number>()

/**
 * Provides a Redis-backed `RateLimiterStore` using `makeStoreRedis`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerStoreRedis: (
  options?: { readonly prefix?: string | undefined }
) => Layer.Layer<
  RateLimiterStore,
  never,
  Redis.Redis
> = flow(makeStoreRedis, Layer.effect(RateLimiterStore))

/**
 * Provides a Redis-backed `RateLimiterStore` from wrapped configuration
 * options.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerStoreRedisConfig = (
  options: Config.Wrap<{ readonly prefix?: string | undefined }>
): Layer.Layer<RateLimiterStore, Config.ConfigError, Redis.Redis> =>
  Layer.effect(
    RateLimiterStore,
    Effect.flatMap(Config.unwrap(options), makeStoreRedis)
  )
