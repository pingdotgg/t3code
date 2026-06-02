import { assert, describe, it } from "@effect/vitest"
import { Effect, Latch } from "effect"

describe("Latch", () => {
  it.effect("release wakes current waiters and keeps the latch closed", () =>
    Effect.gen(function*() {
      const latch = yield* Latch.make(false)
      const waiter = yield* Effect.forkChild(
        Latch.await(latch),
        { startImmediately: true }
      )

      assert.isUndefined(waiter.pollUnsafe())

      yield* latch.release
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      assert.isDefined(waiter.pollUnsafe())
    }))
})
