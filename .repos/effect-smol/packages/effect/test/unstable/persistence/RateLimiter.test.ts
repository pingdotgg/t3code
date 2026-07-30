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

  describe("adaptive", () => {
    it.effect("uses the inactive store path until 429 Retry-After feedback", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const consume = store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        let result = yield* consume
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.epoch, 0)
        assert.strictEqual(result.phase, "inactive")

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: result.epoch,
          tokens: 1,
          status: 200,
          retryAfter: Duration.seconds(1)
        })

        result = yield* consume
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.epoch, 0)
        assert.strictEqual(result.phase, "inactive")

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: result.epoch,
          tokens: 1,
          status: 429,
          retryAfter: undefined
        })

        result = yield* consume
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.epoch, 0)
        assert.strictEqual(result.phase, "inactive")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("starts cooldown on the first 429 Retry-After feedback", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(5)
        })

        const result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.seconds(5))
        assert.strictEqual(result.epoch, 0)
        assert.strictEqual(result.phase, "cooldown")

        const otherKey = yield* store.adaptiveConsume({
          key: "b",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(otherKey.delay, Duration.zero)
        assert.strictEqual(otherKey.epoch, 0)
        assert.strictEqual(otherKey.phase, "inactive")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("clamps zero Retry-After feedback to the minimum cooldown", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.zero
        })

        const result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.millis(1))
        assert.strictEqual(result.epoch, 0)
        assert.strictEqual(result.phase, "cooldown")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("bounds excessive adaptive Retry-After cooldowns", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.hours(2)
        })

        let result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.hours(1))
        assert.strictEqual(result.epoch, 0)
        assert.strictEqual(result.phase, "cooldown")

        yield* TestClock.adjust(Duration.hours(1))

        result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.epoch, 1)
        assert.strictEqual(result.phase, "learning")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("returns the remaining cooldown delay", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(10)
        })
        yield* TestClock.adjust(Duration.seconds(4))

        const result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.seconds(6))
        assert.strictEqual(result.epoch, 0)
        assert.strictEqual(result.phase, "cooldown")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("starts learning on the first admitted post-cooldown request", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(10)
        })
        yield* TestClock.adjust(Duration.seconds(10))

        const result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 2,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.epoch, 1)
        assert.strictEqual(result.phase, "learning")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("keeps learning requests at zero delay while observing token counts", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(1)
        })
        yield* TestClock.adjust(Duration.seconds(1))

        const learning = yield* store.adaptiveConsume({
          key: "a",
          tokens: 2,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.strictEqual(learning.phase, "learning")

        const result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 3,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.epoch, learning.epoch)
        assert.strictEqual(result.phase, "learning")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("learns the accepted token count and inferred window from learning feedback", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(1)
        })
        yield* TestClock.adjust(Duration.seconds(1))

        const learning = yield* store.adaptiveConsume({
          key: "a",
          tokens: 2,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        yield* TestClock.adjust(Duration.seconds(4))
        const rejected = yield* store.adaptiveConsume({
          key: "a",
          tokens: 3,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: rejected.epoch,
          tokens: 3,
          status: 429,
          retryAfter: Duration.seconds(6)
        })
        yield* TestClock.adjust(Duration.seconds(6))

        assert.strictEqual(learning.epoch, rejected.epoch)

        let result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.phase, "learned")

        result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.phase, "learned")

        result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.seconds(10))
        assert.strictEqual(result.phase, "learned")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("ignores stale epoch feedback", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(1)
        })
        yield* TestClock.adjust(Duration.seconds(1))

        const learning = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(10)
        })

        const result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.epoch, learning.epoch)
        assert.strictEqual(result.phase, "learning")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("prevents repeated learning 429 feedback from corrupting learned state", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(1)
        })
        yield* TestClock.adjust(Duration.seconds(1))

        yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        const rejected = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: rejected.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(5)
        })
        yield* store.adaptiveFeedback({
          key: "a",
          epoch: rejected.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(30)
        })

        const learned = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(learned.delay, Duration.seconds(5))
        assert.strictEqual(learned.epoch, rejected.epoch + 1)
        assert.strictEqual(learned.phase, "learned")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("same-epoch learned 429 feedback enters cooldown and can only extend it", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(1)
        })
        yield* TestClock.adjust(Duration.seconds(1))

        yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        const rejected = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: rejected.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(5)
        })

        const learned = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        yield* store.adaptiveFeedback({
          key: "a",
          epoch: learned.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(5)
        })
        yield* store.adaptiveFeedback({
          key: "a",
          epoch: learned.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(10)
        })

        const result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.seconds(10))
        assert.strictEqual(result.epoch, learned.epoch)
        assert.strictEqual(result.phase, "cooldown")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("stores only cooldown when no tokens were accepted during learning", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(1)
        })
        yield* TestClock.adjust(Duration.seconds(1))

        const learning = yield* store.adaptiveConsume({
          key: "a",
          tokens: 2,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        yield* store.adaptiveFeedback({
          key: "a",
          epoch: learning.epoch,
          tokens: 2,
          status: 429,
          retryAfter: Duration.seconds(5)
        })

        let result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.seconds(5))
        assert.strictEqual(result.epoch, learning.epoch)
        assert.strictEqual(result.phase, "cooldown")

        yield* TestClock.adjust(Duration.seconds(5))

        result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.epoch, learning.epoch + 1)
        assert.strictEqual(result.phase, "learning")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("expires learned adaptive state", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(1)
        })
        yield* TestClock.adjust(Duration.seconds(1))

        yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        const rejected = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: rejected.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.seconds(1)
        })

        yield* TestClock.adjust(Duration.seconds(61))

        const result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.epoch, 0)
        assert.strictEqual(result.phase, "inactive")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))

    it.effect("bounds learned adaptive windows and expires the bounded state", () =>
      Effect.gen(function*() {
        const store = yield* RateLimiter.RateLimiterStore
        const first = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: first.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.millis(1)
        })
        yield* TestClock.adjust(Duration.millis(1))

        yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        const rejected = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })

        yield* store.adaptiveFeedback({
          key: "a",
          epoch: rejected.epoch,
          tokens: 1,
          status: 429,
          retryAfter: Duration.hours(2)
        })

        let result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.hours(1))
        assert.strictEqual(result.phase, "learned")

        yield* TestClock.adjust(Duration.minutes(61))

        result = yield* store.adaptiveConsume({
          key: "a",
          tokens: 1,
          fallbackLimit: 5,
          fallbackWindow: Duration.minutes(1)
        })
        assert.deepStrictEqual(result.delay, Duration.zero)
        assert.strictEqual(result.epoch, 0)
        assert.strictEqual(result.phase, "inactive")
      }).pipe(
        Effect.provide(RateLimiter.layerStoreMemory)
      ))
  })
})
