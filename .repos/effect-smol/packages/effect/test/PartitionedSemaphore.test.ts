import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, PartitionedSemaphore } from "effect"

describe("PartitionedSemaphore", () => {
  it.effect("module-level combinators delegate to the instance api", () =>
    Effect.gen(function*() {
      const sem = yield* PartitionedSemaphore.make<string>({ permits: 2 })

      assert.strictEqual(PartitionedSemaphore.capacity(sem), 2)
      assert.strictEqual(yield* PartitionedSemaphore.available(sem), 2)

      yield* PartitionedSemaphore.take(sem, "a", 1)
      assert.strictEqual(yield* PartitionedSemaphore.available(sem), 1)

      const value = yield* PartitionedSemaphore.withPermit(sem, "a", Effect.succeed(1))
      assert.strictEqual(value, 1)

      const released = yield* PartitionedSemaphore.release(sem, 1)
      assert.strictEqual(released, 2)

      const value2 = yield* PartitionedSemaphore.withPermits(sem, "b", 2, Effect.succeed(2))
      assert.strictEqual(value2, 2)

      const available = yield* PartitionedSemaphore.withPermitsIfAvailable(sem, 1, Effect.succeed("ok"))
      assert.deepStrictEqual(available, Option.some("ok"))

      const piped = yield* Effect.succeed(3).pipe(PartitionedSemaphore.withPermit(sem, "c"))
      assert.strictEqual(piped, 3)

      const piped2 = yield* Effect.succeed(4).pipe(PartitionedSemaphore.withPermits(sem, "c", 1))
      assert.strictEqual(piped2, 4)

      const pipedAvailable = yield* Effect.succeed("pipe").pipe(PartitionedSemaphore.withPermitsIfAvailable(sem, 1))
      assert.deepStrictEqual(pipedAvailable, Option.some("pipe"))
    }))

  it.effect("zero permits run immediately", () =>
    Effect.gen(function*() {
      const sem = yield* PartitionedSemaphore.make<string>({ permits: 1 })
      let executed = false

      yield* PartitionedSemaphore.withPermits(
        sem,
        "a",
        0,
        Effect.sync(() => {
          executed = true
        })
      )

      assert.isTrue(executed)
      assert.strictEqual(yield* PartitionedSemaphore.available(sem), 1)
    }))

  it.effect("withPermitsIfAvailable does not block or run when unavailable", () =>
    Effect.gen(function*() {
      const sem = yield* PartitionedSemaphore.make<string>({ permits: 1 })
      let executed = false

      yield* PartitionedSemaphore.take(sem, "a", 1)

      const result = yield* PartitionedSemaphore.withPermitsIfAvailable(
        sem,
        1,
        Effect.sync(() => {
          executed = true
          return "ok"
        })
      )

      assert.deepStrictEqual(result, Option.none())
      assert.isFalse(executed)
    }))
})
