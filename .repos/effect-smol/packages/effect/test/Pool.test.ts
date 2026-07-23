import { assert, describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Deferred, Duration, Effect, Exit, Fiber, pipe, Pool, Ref, Schedule, Scope } from "effect"
import { TestClock } from "effect/testing"

describe("Pool", () => {
  it.effect("preallocates pool items", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      yield* Pool.make({ acquire: get, size: 10 })
      yield* Effect.repeat(Ref.get(count), { until: (n) => n === 10 })
      const result = yield* Ref.get(count)
      strictEqual(result, 10)
    }))

  // it.effect("benchmark", () =>
  //   Effect.gen(function*() {
  //     const get = Effect.succeed("resource")
  //     const pool = yield* Pool.make({ acquire: get, size: 10 })
  //     yield* Pool.get(pool).pipe(
  //       Effect.scoped,
  //       Effect.repeatN(10000),
  //       Console.withTime("Pool.get")
  //     )
  //   }))

  it.effect("cleans up items when shut down", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const scope = yield* Scope.make()
      yield* Scope.provide(Pool.make({ acquire: get, size: 10 }), scope)
      yield* Effect.repeat(Ref.get(count), { until: (n) => n === 10 })
      yield* Scope.close(scope, Exit.succeed(void 0))
      const result = yield* Ref.get(count)
      strictEqual(result, 0)
    }))

  it.effect("defects don't prevent cleanup", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Effect.andThen(Ref.update(count, (n) => n - 1), Effect.die("boom"))
      )
      const scope = yield* Scope.make()
      yield* Scope.provide(Pool.make({ acquire: get, size: 10 }), scope)
      yield* Effect.repeat(Ref.get(count), { until: (n) => n === 10 })
      yield* Scope.close(scope, Exit.succeed(void 0))
      const result = yield* Ref.get(count)
      strictEqual(result, 0)
    }))

  it.effect("acquire one item", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const pool = yield* Pool.make({ acquire: get, size: 10 })
      yield* Effect.repeat(Ref.get(count), { until: (n) => n === 10 })
      const item = yield* Pool.get(pool)
      strictEqual(item, 1)
    }))

  it.effect("reports failures via get", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Effect.flatMap(
          Ref.updateAndGet(count, (n) => n + 1),
          Effect.fail
        ),
        () => Ref.update(count, (n) => n - 1)
      )
      const pool = yield* Pool.make({ acquire: get, size: 10 })
      const values = yield* Effect.all(Effect.replicate(9)(Effect.flip(Pool.get(pool))))
      deepStrictEqual(Array.from(values), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    }))

  it.live("blocks when item not available", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const pool = yield* Pool.make({ acquire: get, size: 10 })
      yield* Effect.repeat(Ref.get(count), { until: (n) => n === 10 })
      yield* Effect.all(Effect.replicate(10)(Pool.get(pool)))
      const result = yield* Effect.scoped(Pool.get(pool)).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.sleep(10)
      assert.isUndefined(result.pollUnsafe())
    }))

  it.effect("reuse released items", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const pool = yield* Pool.make({ acquire: get, size: 10 })
      yield* Effect.replicateEffect(99)(Effect.scoped(Pool.get(pool)))
      const result = yield* Ref.get(count)
      strictEqual(result, 10)
    }))

  it.effect("invalidate item", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const pool = yield* Pool.make({ acquire: get, size: 10 })
      yield* Effect.repeat(Ref.get(count), { until: (n) => n === 10 })
      yield* Pool.invalidate(pool, 1)
      yield* Effect.repeat(Ref.get(count), { until: (n) => n === 10 })
      const result = yield* Effect.scoped(Pool.get(pool))
      const value = yield* Ref.get(count)
      strictEqual(result, 2)
      strictEqual(value, 10)
    }))

  it.effect("invalidate all items in pool and check that pool.get doesn't hang forever", () =>
    Effect.gen(function*() {
      const allocated = yield* Ref.make(0)
      const finalized = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(allocated, (n) => n + 1),
        () => Ref.update(finalized, (n) => n + 1)
      )
      const pool = yield* Pool.make({ acquire: get, size: 2 })
      yield* Effect.repeat(Ref.get(allocated), { until: (n) => n === 2 })
      yield* Pool.invalidate(pool, 1)
      yield* Pool.invalidate(pool, 2)
      const result = yield* Effect.scoped(Pool.get(pool))
      const allocatedCount = yield* Ref.get(allocated)
      const finalizedCount = yield* Ref.get(finalized)
      strictEqual(result, 3)
      strictEqual(allocatedCount, 4)
      strictEqual(finalizedCount, 2)
    }))

  it.live("retry on failed acquire should not exhaust pool", () =>
    Effect.gen(function*() {
      const acquire = Effect.as(Effect.fail("error"), 1)
      const pool = yield* Pool.makeWithTTL({ acquire, min: 0, max: 1, timeToLive: Duration.infinity })
      const result = yield* pipe(
        Effect.scoped(Effect.retry(Pool.get(pool), { times: 5 })),
        Effect.timeoutOrElse({
          orElse: () => Effect.fail("timeout"),
          duration: Duration.seconds(1)
        }),
        Effect.flip
      )
      strictEqual(result, "error")
    }))

  it.effect("compositional retry", () =>
    Effect.gen(function*() {
      const cond = (i: number) => (i <= 10 ? Effect.fail(i) : Effect.succeed(i))
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1).pipe(
          Effect.flatMap(cond)
        ),
        () => Ref.update(count, (n) => n - 1)
      )
      const pool = yield* Pool.make({ acquire: get, size: 10 })
      const result = yield* Effect.retry(Effect.scoped(Pool.get(pool)), Schedule.forever)
      strictEqual(result, 11)
    }))

  it.effect("max pool size", () =>
    Effect.gen(function*() {
      const deferred = yield* Deferred.make<void>()
      const count = yield* Ref.make(0)
      const acquire = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const pool = yield* Pool.makeWithTTL({
        acquire,
        min: 10,
        max: 15,
        timeToLive: Duration.seconds(60)
      })
      yield* pipe(
        Effect.scoped(Effect.andThen(
          Pool.get(pool),
          Deferred.await(deferred)
        )),
        Effect.forkChild,
        Effect.repeat({ times: 14 })
      )
      yield* Effect.repeat(Ref.get(count), { until: (n) => n === 15 })
      yield* Deferred.succeed(deferred, void 0)
      const max = yield* Ref.get(count)
      yield* TestClock.adjust(Duration.seconds(60))
      const min = yield* Ref.get(count)
      strictEqual(min, 10)
      strictEqual(max, 15)
    }))

  it.effect("max pool size with concurrency: 3", () =>
    Effect.gen(function*() {
      const deferred = yield* Deferred.make<void>()
      const count = yield* Ref.make(0)
      const acquire = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const pool = yield* Pool.makeWithTTL({
        acquire,
        min: 10,
        max: 15,
        concurrency: 3,
        timeToLive: Duration.seconds(60)
      })
      yield* pipe(
        Effect.scoped(Effect.andThen(
          Pool.get(pool),
          Deferred.await(deferred)
        )),
        Effect.forkChild,
        Effect.repeat({ times: 14 * 3 })
      )
      yield* Effect.repeat(Ref.get(count), { until: (n) => n === 15 })
      yield* Deferred.succeed(deferred, void 0)
      const max = yield* Ref.get(count)
      yield* TestClock.adjust(Duration.seconds(60))
      const min = yield* Ref.get(count)
      strictEqual(min, 10)
      strictEqual(max, 15)
    }))

  it.effect("concurrency reclaim", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const acquire = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const pool = yield* Pool.makeWithTTL({
        acquire,
        min: 0,
        max: 2,
        concurrency: 2,
        timeToLive: Duration.seconds(60)
      })

      const scope1 = yield* Scope.make()
      yield* Scope.provide(Pool.get(pool), scope1)
      yield* Pool.get(pool)
      yield* Effect.scoped(Pool.get(pool))
      yield* TestClock.adjust(Duration.seconds(60))
      yield* Scope.close(scope1, Exit.void)
      yield* Pool.get(pool)
      yield* Pool.get(pool)
      strictEqual(yield* Pool.get(pool), 1)
      strictEqual(yield* Ref.get(count), 2)
    }))

  it.effect("scale to zero", () =>
    Effect.gen(function*() {
      const deferred = yield* Deferred.make<void>()
      const count = yield* Ref.make(0)
      const acquire = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const pool = yield* Pool.makeWithTTL({
        acquire,
        min: 0,
        max: 10,
        concurrency: 3,
        timeToLive: Duration.seconds(60)
      })
      yield* pipe(
        Effect.scoped(Effect.andThen(
          Pool.get(pool),
          Deferred.await(deferred)
        )),
        Effect.forkChild,
        Effect.repeat({ times: 29 })
      )
      yield* Effect.repeat(Ref.get(count), { until: (n) => n === 10 })
      yield* Deferred.succeed(deferred, void 0)
      const max = yield* Ref.get(count)
      yield* TestClock.adjust(Duration.seconds(60))
      const min = yield* Ref.get(count)
      strictEqual(min, 0)
      strictEqual(max, 10)
    }))

  it.effect("max pool size creation strategy", () =>
    Effect.gen(function*() {
      const invalidated = yield* Ref.make(0)
      const acquire = Effect.acquireRelease(
        Effect.succeed("resource"),
        () => Ref.update(invalidated, (n) => n + 1)
      )
      const pool = yield* Pool.makeWithTTL({
        acquire,
        min: 10,
        max: 15,
        timeToLive: Duration.seconds(60),
        timeToLiveStrategy: "creation"
      })
      const scope = yield* Scope.make()
      yield* Pool.get(pool).pipe(
        Effect.repeat({ times: 14 }),
        Scope.provide(scope)
      )
      const one = yield* Ref.get(invalidated)
      yield* TestClock.adjust(Duration.seconds(60))
      const two = yield* Ref.get(invalidated)
      yield* Scope.close(scope, Exit.void)
      const three = yield* Ref.get(invalidated)
      strictEqual(one, 0)
      strictEqual(two, 0)
      strictEqual(three, 15)
    }))

  it.effect("shutdown robustness", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const scope = yield* Scope.make()
      const pool = yield* Scope.provide(Pool.make({ acquire: get, size: 10 }), scope)
      yield* pipe(
        Effect.scoped(Pool.get(pool)),
        Effect.forkChild,
        Effect.repeat({ times: 99 })
      )
      yield* Scope.close(scope, Exit.succeed(void 0))
      const result = yield* Effect.repeat(Ref.get(count), { until: (n) => n === 0 })
      strictEqual(result, 0)
    }))

  it.effect("shutdown with pending takers", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const scope = yield* Scope.make()
      const pool = yield* Scope.provide(Pool.make({ acquire: get, size: 10 }), scope)
      yield* pipe(
        Pool.get(pool),
        Scope.provide(scope),
        Effect.forkChild,
        Effect.repeat({ times: 99 })
      )
      yield* Scope.close(scope, Exit.succeed(void 0))
      const result = yield* Effect.repeat(Ref.get(count), { until: (n) => n === 0 })
      strictEqual(result, 0)
    }))

  it.effect("get is interruptible", () =>
    Effect.gen(function*() {
      const count = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(count, (n) => n + 1),
        () => Ref.update(count, (n) => n - 1)
      )
      const fiberId = Fiber.getCurrent()!.id
      const pool = yield* Pool.make({ acquire: get, size: 10 })
      yield* Effect.repeat(Pool.get(pool), { times: 9 })
      const fiber = yield* Effect.forkChild(Pool.get(pool))
      yield* Fiber.interrupt(fiber)
      deepStrictEqual(fiber.pollUnsafe(), Exit.interrupt(fiberId))
    }))

  it.effect("get is interruptible with dynamic size", () =>
    Effect.gen(function*() {
      const get = Effect.never.pipe(Effect.forkScoped)
      const fiberId = Fiber.getCurrent()!.id
      const pool = yield* Pool.makeWithTTL({ acquire: get, min: 0, max: 10, timeToLive: Duration.infinity })
      yield* Effect.repeat(Pool.get(pool), { times: 9 })
      const fiber = yield* Effect.forkChild(Pool.get(pool))
      yield* Fiber.interrupt(fiber)
      deepStrictEqual(yield* Fiber.await(fiber), Exit.interrupt(fiberId))
    }))

  it.effect("finalizer is called for failed allocations", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const allocations = yield* Ref.make(0)
      const released = yield* Ref.make(0)
      const get = Effect.acquireRelease(
        Ref.updateAndGet(allocations, (n) => n + 1),
        () => Ref.update(released, (n) => n + 1)
      ).pipe(
        Effect.andThen(Effect.fail("boom"))
      )
      const pool = yield* Pool.make({ acquire: get, size: 10 }).pipe(
        Scope.provide(scope)
      )
      yield* Effect.scoped(Pool.get(pool)).pipe(
        Effect.ignore
      )
      strictEqual(yield* Ref.get(allocations), 10)
      strictEqual(yield* Ref.get(released), 10)
    }))
})
