import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { RateLimiter } from "effect/unstable/persistence"

describe(`RateLimiter`, () => {
  describe("fixed-window", () => {
    it.effect("returns accumulated delays after the fixed window is exceeded", () =>
      Effect.gen(function*() {
        const limiter = yield* RateLimiter.make
        const consume = limiter.consume({
          algorithm: "fixed-window",
          onExceeded: "delay",
          window: "1 minute",
          limit: 5,
          tokens: 1,
          key: "a"
        })
        yield* Effect.repeat(consume, { times: 3 }) // 1 + 3
        let result = yield* consume // 5
        assert.deepStrictEqual(result.delay, Duration.zero)
        result = yield* consume // 6
        assert.deepStrictEqual(result.delay, Duration.minutes(1))

        yield* Effect.repeat(consume, { times: 2 }) // 7,8,9
        result = yield* consume // 10
        assert.deepStrictEqual(result.delay, Duration.minutes(1))
        result = yield* consume // 11
        assert.deepStrictEqual(result.delay, Duration.minutes(2))

        yield* TestClock.adjust(Duration.seconds(30))

        result = yield* consume // 12
        assert.deepStrictEqual(result.delay, Duration.seconds(90))

        yield* TestClock.adjust(Duration.seconds(45))

        result = yield* consume // 13
        assert.deepStrictEqual(result.delay, Duration.seconds(45))
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("fails with retryAfter until the fixed window resets", () =>
      Effect.gen(function*() {
        const limiter = yield* RateLimiter.make
        const consume = limiter.consume({
          algorithm: "fixed-window",
          onExceeded: "fail",
          window: "1 minute",
          limit: 5,
          tokens: 1,
          key: "a"
        })
        yield* Effect.repeat(consume, { times: 3 })
        let result = yield* consume
        assert.deepStrictEqual(result.delay, Duration.zero)
        let error = yield* Effect.flip(consume)
        if (error.reason._tag !== "RateLimitExceeded") {
          throw new Error("Expected RateLimitExceeded")
        }
        assert.deepStrictEqual(error.reason.retryAfter, Duration.minutes(1))
        assert.strictEqual(error.reason.remaining, 0)

        yield* TestClock.adjust(Duration.seconds(30))

        error = yield* Effect.flip(consume)
        if (error.reason._tag !== "RateLimitExceeded") {
          throw new Error("Expected RateLimitExceeded")
        }
        assert.deepStrictEqual(error.reason.retryAfter, Duration.seconds(30))
        assert.strictEqual(error.reason.remaining, 0)

        yield* TestClock.adjust(Duration.seconds(30))

        result = yield* consume
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.remaining, 4)
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))
  })

  describe("token-bucket", () => {
    it.effect("returns delay based on the token refill rate", () =>
      Effect.gen(function*() {
        const limiter = yield* RateLimiter.make
        const consume = limiter.consume({
          algorithm: "token-bucket",
          onExceeded: "delay",
          window: "1 minute",
          limit: 5,
          tokens: 1,
          key: "a"
        })
        const refillRate = Duration.divideUnsafe(Duration.minutes(1), 5)
        yield* Effect.repeat(consume, { times: 3 }) // 1 + 3
        let result = yield* consume // 5
        assert.deepStrictEqual(result.delay, Duration.zero)
        result = yield* consume // 6
        assert.deepStrictEqual(result.delay, refillRate)
        result = yield* consume // 7
        assert.deepStrictEqual(result.delay, Duration.times(refillRate, 2))

        yield* TestClock.adjust(Duration.minutes(1)) // 2

        result = yield* consume // 3
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.remaining, 2)
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("fails until enough tokens are refilled", () =>
      Effect.gen(function*() {
        const limiter = yield* RateLimiter.make
        const consume = limiter.consume({
          algorithm: "token-bucket",
          onExceeded: "fail",
          window: "1 minute",
          limit: 5,
          tokens: 1,
          key: "a"
        })
        const refillRate = Duration.divideUnsafe(Duration.minutes(1), 5)
        yield* Effect.repeat(consume, { times: 3 }) // 1 + 3
        let result = yield* consume
        assert.deepStrictEqual(result.delay, Duration.zero)
        const error = yield* Effect.flip(consume)
        if (error.reason._tag !== "RateLimitExceeded") {
          throw new Error("Expected RateLimitExceeded")
        }
        assert.deepStrictEqual(error.reason.retryAfter, Duration.seconds(12))
        assert.strictEqual(error.reason.remaining, 0)

        yield* TestClock.adjust(Duration.times(refillRate, 3))

        result = yield* consume
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.remaining, 2)
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))
  })
})
