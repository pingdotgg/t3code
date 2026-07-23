import { assert, describe, it } from "@effect/vitest"
import { Array, Effect, Exit, Fiber, Latch, PubSub, Stream } from "effect"
import { pipe } from "effect/Function"

describe("PubSub", () => {
  it.effect("publishAll - capacity 2 (BoundedPubSubPow2)", () => {
    const messages = [1, 2]
    return PubSub.bounded<number>(2).pipe(
      Effect.flatMap((pubsub) =>
        Effect.scoped(
          Effect.gen(function*() {
            const sub1 = yield* PubSub.subscribe(pubsub)
            const sub2 = yield* PubSub.subscribe(pubsub)
            yield* PubSub.publishAll(pubsub, messages)
            const takes1 = yield* PubSub.takeAll(sub1)
            const takes2 = yield* PubSub.takeAll(sub2)
            assert.deepStrictEqual(takes1, messages)
            assert.deepStrictEqual(takes2, messages)
          })
        )
      )
    )
  })
  it.effect("publishAll - capacity 4 (BoundedPubSubPow2)", () => {
    const messages = [1, 2]
    return PubSub.bounded<number>(4).pipe(
      Effect.flatMap((pubsub) =>
        Effect.scoped(
          Effect.gen(function*() {
            const sub1 = yield* PubSub.subscribe(pubsub)
            const sub2 = yield* PubSub.subscribe(pubsub)
            yield* PubSub.publishAll(pubsub, messages)
            const takes1 = yield* PubSub.takeAll(sub1)
            const takes2 = yield* PubSub.takeAll(sub2)
            assert.deepStrictEqual(takes1, messages)
            assert.deepStrictEqual(takes2, messages)
          })
        )
      )
    )
  })
  it.effect("publishAll - capacity 3 (BoundedPubSubArb)", () => {
    const messages = [1, 2]
    return PubSub.bounded<number>(3).pipe(
      Effect.flatMap((pubsub) =>
        Effect.scoped(
          Effect.gen(function*() {
            const sub1 = yield* PubSub.subscribe(pubsub)
            const sub2 = yield* PubSub.subscribe(pubsub)
            yield* PubSub.publishAll(pubsub, messages)
            const takes1 = yield* PubSub.takeAll(sub1)
            const takes2 = yield* PubSub.takeAll(sub2)
            assert.deepStrictEqual(takes1, messages)
            assert.deepStrictEqual(takes2, messages)
          })
        )
      )
    )
  })
  it.effect("sequential publishers and subscribers with one publisher and one subscriber", () =>
    Effect.gen(function*() {
      const values = Array.range(0, 9)
      const latch = yield* Latch.make()
      const pubsub = yield* PubSub.bounded<number>(10)
      const subscriber = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) =>
          latch.await.pipe(
            Effect.andThen(Effect.forEach(values, () => PubSub.take(subscription)))
          )
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* PubSub.publishAll(pubsub, values)
      yield* latch.open
      const result = yield* Fiber.join(subscriber)
      assert.deepStrictEqual(result, values)
    }))
  it.effect("sequential publishers and subscribers with one publisher and two subscribers", () =>
    Effect.gen(function*() {
      const values = Array.range(0, 9)
      const latch = yield* Latch.make()
      const pubsub = yield* PubSub.bounded<number>(10)
      const subscriber1 = yield* pubsub.pipe(
        PubSub.subscribe,
        Effect.flatMap((subscription) =>
          pipe(
            latch.await,
            Effect.andThen(pipe(values, Effect.forEach(() => PubSub.take(subscription))))
          )
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const subscriber2 = yield* pubsub.pipe(
        PubSub.subscribe,
        Effect.flatMap((subscription) =>
          pipe(
            latch.await,
            Effect.andThen(pipe(values, Effect.forEach(() => PubSub.take(subscription))))
          )
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* PubSub.publishAll(pubsub, values)
      yield* latch.open
      const result1 = yield* Fiber.join(subscriber1)
      const result2 = yield* Fiber.join(subscriber2)
      assert.deepStrictEqual(result1, values)
      assert.deepStrictEqual(result2, values)
    }))
  it.effect("backpressured concurrent publishers and subscribers - one to one", () =>
    Effect.gen(function*() {
      const values = Array.range(0, 64)
      const pubsub = yield* PubSub.bounded<number>(64)
      const subscriber = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.forkChild(PubSub.publishAll(pubsub, values))
      const result = yield* Fiber.join(subscriber)
      assert.deepStrictEqual(result, values)
    }))
  it.effect("backpressured concurrent publishers and subscribers - one to many", () =>
    Effect.gen(function*() {
      const values = Array.range(0, 64)
      const pubsub = yield* PubSub.bounded<number>(64)
      const subscriber1 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const subscriber2 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.forkChild(PubSub.publishAll(pubsub, values))
      const result1 = yield* Fiber.join(subscriber1)
      const result2 = yield* Fiber.join(subscriber2)
      assert.deepStrictEqual(result1, values)
      assert.deepStrictEqual(result2, values)
    }))
  it.effect("backpressured concurrent publishers and subscribers - many to many", () =>
    Effect.gen(function*() {
      const values = Array.range(1, 64)
      const pubsub = yield* PubSub.bounded<number>(64 * 2)
      const subscriber1 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values.concat(values), (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const subscriber2 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values.concat(values), (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const fiber = yield* Effect.forkChild(PubSub.publishAll(pubsub, values))
      yield* Effect.forkChild(PubSub.publishAll(pubsub, Array.map(values, (n) => -n)))
      const result1 = yield* Fiber.join(subscriber1)
      const result2 = yield* Fiber.join(subscriber2)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(Array.filter(result1, (n) => n > 0), values)
      assert.deepStrictEqual(
        Array.filter(result1, (n) => n < 0),
        Array.map(values, (n) => -n)
      )
      assert.deepStrictEqual(Array.filter(result2, (n) => n > 0), values)
      assert.deepStrictEqual(
        Array.filter(result2, (n) => n < 0),
        Array.map(values, (n) => -n)
      )
    }))
  it.effect("dropping concurrent publishers and subscribers - one to one", () =>
    Effect.gen(function*() {
      const values = Array.range(0, 64)
      const pubsub = yield* PubSub.dropping<number>(64)
      const subscriber = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.forkChild(Effect.forEach(values, (n) => PubSub.publish(pubsub, n)))
      const result = yield* Fiber.join(subscriber)
      assert.deepStrictEqual(result, values)
    }))
  it.effect("dropping concurrent publishers and subscribers - one to many", () =>
    Effect.gen(function*() {
      const values = Array.range(0, 64)
      const pubsub = yield* PubSub.dropping<number>(64)
      const subscriber1 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const subscriber2 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.forkChild(Effect.forEach(values, (n) => PubSub.publish(pubsub, n)))
      const result1 = yield* Fiber.join(subscriber1)
      const result2 = yield* Fiber.join(subscriber2)
      assert.deepStrictEqual(result1, values)
      assert.deepStrictEqual(result2, values)
    }))
  it.effect("dropping concurrent publishers and subscribers - many to many", () =>
    Effect.gen(function*() {
      const values = Array.range(1, 64)
      const pubsub = yield* PubSub.dropping<number>(64 * 2)
      const subscriber1 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values.concat(values), (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const subscriber2 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values.concat(values), (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const fiber = yield* Effect.forkChild(Effect.forEach(values, (n) => PubSub.publish(pubsub, n)))
      yield* Effect.forkChild(Effect.forEach(values, (n) => PubSub.publish(pubsub, -n)))
      const result1 = yield* Fiber.join(subscriber1)
      const result2 = yield* Fiber.join(subscriber2)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(pipe(result1, Array.filter((n) => n > 0)), values)
      assert.deepStrictEqual(
        pipe(result1, Array.filter((n) => n < 0)),
        pipe(values, Array.map((n) => -n))
      )
      assert.deepStrictEqual(pipe(result2, Array.filter((n) => n > 0)), values)
      assert.deepStrictEqual(
        pipe(result2, Array.filter((n) => n < 0)),
        pipe(values, Array.map((n) => -n))
      )
    }))
  it.effect("sliding concurrent publishers and subscribers - one to one", () =>
    Effect.gen(function*() {
      const values = Array.range(0, 64)
      const pubsub = yield* PubSub.sliding<number>(64)
      const subscriber = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.forkChild(Effect.forEach(values, (n) => PubSub.publish(pubsub, n)))
      const result = yield* Fiber.join(subscriber)
      assert.deepStrictEqual(result, values)
    }))
  it.effect("sliding concurrent publishers and subscribers - one to many", () =>
    Effect.gen(function*() {
      const values = Array.range(0, 64)
      const pubsub = yield* PubSub.sliding<number>(64)
      const subscriber1 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const subscriber2 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.forkChild(PubSub.publishAll(pubsub, values))
      const result1 = yield* Fiber.join(subscriber1)
      const result2 = yield* Fiber.join(subscriber2)
      assert.deepStrictEqual(result1, values)
      assert.deepStrictEqual(result2, values)
    }))
  it.effect("sliding concurrent publishers and subscribers - many to many", () =>
    Effect.gen(function*() {
      const values = Array.range(1, 64)
      const pubsub = yield* PubSub.sliding<number>(64 * 2)
      const subscriber1 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values.concat(values), (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const subscriber2 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values.concat(values), (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const fiber = yield* Effect.forkChild(PubSub.publishAll(pubsub, values))
      yield* Effect.forkChild(PubSub.publishAll(pubsub, Array.map(values, (n) => -n)))
      const result1 = yield* Fiber.join(subscriber1)
      const result2 = yield* Fiber.join(subscriber2)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(pipe(result1, Array.filter((n) => n > 0)), values)
      assert.deepStrictEqual(
        pipe(result1, Array.filter((n) => n < 0)),
        pipe(values, Array.map((n) => -n))
      )
      assert.deepStrictEqual(pipe(result2, Array.filter((n) => n > 0)), values)
      assert.deepStrictEqual(
        pipe(result2, Array.filter((n) => n < 0)),
        pipe(values, Array.map((n) => -n))
      )
    }))
  it.effect("unbounded concurrent publishers and subscribers - one to one", () =>
    Effect.gen(function*() {
      const values = Array.range(0, 64)
      const pubsub = yield* PubSub.unbounded<number>()
      const subscriber = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.forkChild(PubSub.publishAll(pubsub, values))

      const result = yield* Fiber.join(subscriber)
      assert.deepStrictEqual(result, values)
    }))
  it.effect("unbounded concurrent publishers and subscribers - one to many", () =>
    Effect.gen(function*() {
      const values = Array.range(0, 64)
      const pubsub = yield* PubSub.unbounded<number>()
      const subscriber1 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const subscriber2 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values, (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.forkChild(PubSub.publishAll(pubsub, values))
      const result1 = yield* Fiber.join(subscriber1)
      const result2 = yield* Fiber.join(subscriber2)
      assert.deepStrictEqual(result1, values)
      assert.deepStrictEqual(result2, values)
    }))
  it.effect("unbounded concurrent publishers and subscribers - many to many", () =>
    Effect.gen(function*() {
      const values = Array.range(1, 64)
      const pubsub = yield* PubSub.unbounded<number>()
      const subscriber1 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values.concat(values), (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )

      const subscriber2 = yield* PubSub.subscribe(pubsub).pipe(
        Effect.flatMap((subscription) => Effect.forEach(values.concat(values), (_) => PubSub.take(subscription))),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      const fiber = yield* Effect.forkChild(PubSub.publishAll(pubsub, values))
      yield* Effect.forkChild(PubSub.publishAll(pubsub, Array.map(values, (n) => -n)))
      const result1 = yield* Fiber.join(subscriber1)
      const result2 = yield* Fiber.join(subscriber2)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(Array.filter(result1, (n) => n > 0), values)
      assert.deepStrictEqual(
        Array.filter(result1, (n) => n < 0),
        Array.map(values, (n) => -n)
      )
      assert.deepStrictEqual(Array.filter(result2, (n) => n > 0), values)
      assert.deepStrictEqual(
        Array.filter(result2, (n) => n < 0),
        Array.map(values, (n) => -n)
      )
    }))
  it.effect("null values", () => {
    const messages = [1, null]
    return PubSub.unbounded<number | null>().pipe(
      Effect.flatMap((pubsub) =>
        Effect.scoped(
          Effect.gen(function*() {
            const sub1 = yield* PubSub.subscribe(pubsub)
            const sub2 = yield* PubSub.subscribe(pubsub)
            yield* PubSub.publishAll(pubsub, messages)
            const takes1 = yield* PubSub.takeAll(sub1)
            const takes2 = yield* PubSub.takeAll(sub2)
            assert.deepStrictEqual([...takes1], messages)
            assert.deepStrictEqual([...takes2], messages)
          })
        )
      )
    )
  })

  it.effect("publish does not increase size while no subscribers", () =>
    Effect.gen(function*() {
      const pubsub = yield* PubSub.dropping<number>(2)
      yield* PubSub.publish(pubsub, 1)
      yield* PubSub.publish(pubsub, 2)
      assert.deepStrictEqual(PubSub.sizeUnsafe(pubsub), 0)
    }))

  it.effect("publishAll does not increase size while no subscribers", () =>
    Effect.gen(function*() {
      const pubsub = yield* PubSub.dropping<number>(2)
      yield* PubSub.publishAll(pubsub, [1, 2])
      assert.deepStrictEqual(PubSub.sizeUnsafe(pubsub), 0)
    }))

  describe("replay", () => {
    it.effect("unbounded", () =>
      Effect.gen(function*() {
        const messages = [1, 2, 3, 4, 5]
        const pubsub = yield* PubSub.unbounded<number>({ replay: 3 })
        yield* PubSub.publishAll(pubsub, messages)
        const sub = yield* PubSub.subscribe(pubsub)
        assert.deepStrictEqual(yield* PubSub.takeAll(sub), [3, 4, 5])
      }))

    it.effect("unbounded takeUpTo", () => {
      const messages = [1, 2, 3, 4, 5]
      return PubSub.unbounded<number>({ replay: 3 }).pipe(
        Effect.flatMap((pubsub) =>
          Effect.scoped(
            Effect.gen(function*() {
              yield* PubSub.publishAll(pubsub, messages)

              const sub1 = yield* PubSub.subscribe(pubsub)
              yield* PubSub.publish(pubsub, 6)
              const sub2 = yield* PubSub.subscribe(pubsub)

              assert.strictEqual(yield* PubSub.remaining(sub1), 4)
              assert.strictEqual(yield* PubSub.remaining(sub2), 3)
              assert.deepStrictEqual(yield* PubSub.takeUpTo(sub1, 2), [3, 4])
              assert.deepStrictEqual(yield* PubSub.takeUpTo(sub1, 2), [5, 6])
              assert.deepStrictEqual(yield* PubSub.takeUpTo(sub2, 3), [4, 5, 6])
            })
          )
        )
      )
    })

    it.effect("dropping", () =>
      Effect.gen(function*() {
        const messages = [1, 2, 3, 4, 5]
        const pubsub = yield* PubSub.dropping<number>({ capacity: 2, replay: 3 })

        yield* PubSub.publishAll(pubsub, messages)
        const sub = yield* PubSub.subscribe(pubsub)
        assert.deepStrictEqual(yield* PubSub.takeAll(sub), [3, 4, 5])
        yield* PubSub.publishAll(pubsub, [6, 7])
        assert.deepStrictEqual(yield* PubSub.takeAll(sub), [6, 7])

        const sub2 = yield* PubSub.subscribe(pubsub)
        assert.deepStrictEqual(yield* PubSub.takeAll(sub2), [5, 6, 7])

        yield* PubSub.publishAll(pubsub, [8, 9, 10, 11])
        assert.deepStrictEqual(yield* PubSub.takeAll(sub), [8, 9])
        assert.deepStrictEqual(yield* PubSub.takeAll(sub2), [8, 9])

        const sub3 = yield* PubSub.subscribe(pubsub)
        assert.deepStrictEqual(yield* PubSub.takeAll(sub3), [7, 8, 9])
      }))

    it.effect("sliding", () =>
      Effect.gen(function*() {
        const messages = [1, 2, 3, 4, 5]
        const pubsub = yield* PubSub.sliding<number>({ capacity: 4, replay: 3 })

        yield* PubSub.publishAll(pubsub, messages)
        const sub = yield* PubSub.subscribe(pubsub)
        assert.deepStrictEqual(yield* PubSub.take(sub), 3)
        yield* PubSub.publishAll(pubsub, [6, 7, 8, 9, 10])
        assert.deepStrictEqual(yield* PubSub.takeAll(sub), [5, 6, 7, 8, 9, 10])

        const sub2 = yield* PubSub.subscribe(pubsub)
        assert.deepStrictEqual(yield* PubSub.takeAll(sub2), [8, 9, 10])

        yield* PubSub.publishAll(pubsub, [11, 12, 13, 14, 15, 16])
        assert.deepStrictEqual(yield* PubSub.takeAll(sub), [13, 14, 15, 16])
        assert.deepStrictEqual(yield* PubSub.takeAll(sub2), [13, 14, 15, 16])

        const sub3 = yield* PubSub.subscribe(pubsub)
        assert.deepStrictEqual(yield* PubSub.takeAll(sub3), [14, 15, 16])
      }))
  })

  it.effect("shutdown interrupts suspended subscribers", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const pubsub = yield* PubSub.unbounded<number>()
        const subscription = yield* PubSub.subscribe(pubsub)
        const fiber = yield* Effect.forkChild(PubSub.take(subscription), { startImmediately: true })

        yield* PubSub.shutdown(pubsub)

        const exit = yield* Fiber.await(fiber)
        assert.isTrue(Exit.hasInterrupts(exit!))
      })
    ))

  it.effect("shutdown interrupts suspended takeAll subscribers", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const pubsub = yield* PubSub.unbounded<number>()
        const subscription = yield* PubSub.subscribe(pubsub)
        const fiber = yield* Effect.forkChild(PubSub.takeAll(subscription), { startImmediately: true })
        yield* PubSub.shutdown(pubsub)
        const exit = yield* Fiber.await(fiber)
        assert.isTrue(Exit.hasInterrupts(exit))
      })
    ))

  it.effect("Stream.fromPubSub completes after shutdown", () =>
    Effect.gen(function*() {
      const pubsub = yield* PubSub.unbounded<number>()
      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.fromPubSub(pubsub)))

      yield* Effect.yieldNow
      assert.isUndefined(fiber.pollUnsafe())

      yield* PubSub.shutdown(pubsub)

      const result = yield* Fiber.join(fiber)
      assert.deepStrictEqual(result, [])
    }))

  it.effect("publish returns false after shutdown", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const pubsub = yield* PubSub.unbounded<number>()
        yield* PubSub.shutdown(pubsub)

        assert.strictEqual(yield* PubSub.publish(pubsub, 1), false)
      })
    ))

  it.effect("publishAll returns false after shutdown", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const pubsub = yield* PubSub.unbounded<number>()
        yield* PubSub.shutdown(pubsub)

        assert.strictEqual(yield* PubSub.publishAll(pubsub, [1, 2, 3]), false)
      })
    ))
})
