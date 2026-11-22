import { makeEntityKeepAlive } from "@effect/platform-cloudflare/internal/entityKeepAlive"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Semaphore } from "effect"

const makeKeepAlive = Effect.fnUntraced(function*(writes: number) {
  const gates = yield* Effect.forEach(Array.from({ length: writes }), () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
      const finish = yield* Deferred.make<void>()
      return { started, finish }
    }))
  const permit = yield* Semaphore.make(1)
  // Match the manager's serialized writes. Await each writer fiber as well
  // as its gate so assertions run after the keep-alive finalizer.
  const values: Array<boolean> = []
  let endHold!: () => void
  const keepAlive = makeEntityKeepAlive({
    wanted: false,
    startHold: () =>
      new Promise<void>((resolve) => {
        endHold = resolve
      }),
    retryCapMillis: () => 30_000,
    persist: (wanted) =>
      Effect.withFiber((fiber) => {
        const gate = gates[values.length]
        values.push(wanted)
        return permit.withPermits(1)(
          Deferred.succeed(gate.started, fiber).pipe(
            Effect.andThen(Deferred.await(gate.finish))
          )
        )
      })
  })
  yield* Effect.addFinalizer(() =>
    Effect.forEach(gates, (gate) => Deferred.succeed(gate.finish, undefined)).pipe(
      Effect.andThen(Effect.sync(() => endHold?.()))
    )
  )
  yield* keepAlive.update(true)
  const first = yield* Deferred.await(gates[0].started)
  const awaitingRelease = yield* Effect.forkChild(keepAlive.await)
  yield* Effect.yieldNow
  return { keepAlive, gates, first, awaitingRelease, values }
})

describe("EntityKeepAlive", () => {
  it.effect("releases only after the false write completes", () =>
    Effect.gen(function*() {
      const { awaitingRelease, first, gates, keepAlive, values } = yield* makeKeepAlive(2)
      yield* keepAlive.update(false)
      yield* Deferred.succeed(gates[0].finish, undefined)
      yield* Fiber.await(first)
      const second = yield* Deferred.await(gates[1].started)
      yield* Effect.yieldNow
      const releasedBeforeFalseWrite = awaitingRelease.pollUnsafe() !== undefined

      yield* Deferred.succeed(gates[1].finish, undefined)
      yield* Fiber.await(second)
      yield* Fiber.join(awaitingRelease)
      assert.deepStrictEqual(values, [true, false])
      assert.isFalse(releasedBeforeFalseWrite)
    }))

  it.effect("keeps the hold when the false write fails", () =>
    Effect.gen(function*() {
      const { awaitingRelease, first, gates, keepAlive } = yield* makeKeepAlive(2)
      yield* Deferred.succeed(gates[0].finish, undefined)
      yield* Fiber.await(first)
      yield* keepAlive.update(false)
      const second = yield* Deferred.await(gates[1].started)
      yield* Deferred.die(gates[1].finish, new Error("false write failed"))
      yield* Fiber.await(second)
      yield* Effect.yieldNow
      assert.isUndefined(awaitingRelease.pollUnsafe())
    }))

  it.effect("keeps the hold when re-pinned during the false write", () =>
    Effect.gen(function*() {
      const { awaitingRelease, first, gates, keepAlive, values } = yield* makeKeepAlive(3)
      yield* Deferred.succeed(gates[0].finish, undefined)
      yield* Fiber.await(first)
      yield* keepAlive.update(false)
      const second = yield* Deferred.await(gates[1].started)
      yield* keepAlive.update(true)
      yield* Deferred.succeed(gates[1].finish, undefined)
      yield* Fiber.await(second)
      const third = yield* Deferred.await(gates[2].started)
      yield* Effect.yieldNow
      assert.isUndefined(awaitingRelease.pollUnsafe())
      yield* Deferred.succeed(gates[2].finish, undefined)
      yield* Fiber.await(third)
      assert.deepStrictEqual(values, [true, false, true])
      assert.isUndefined(awaitingRelease.pollUnsafe())
    }))
})
