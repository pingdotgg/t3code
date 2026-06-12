import { assert, describe, it } from "@effect/vitest"
import { Cause, Data, Effect, Exit, RcMap, Scope } from "effect"
import { TestClock } from "effect/testing"

describe("RcMap", () => {
  it.effect("deallocation", () =>
    Effect.gen(function*() {
      const acquired: Array<string> = []
      const released: Array<string> = []
      const mapScope = yield* Scope.make()
      const map = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired.push(key)
              return key
            }),
            () => Effect.sync(() => released.push(key))
          )
      }).pipe(
        Scope.provide(mapScope)
      )

      assert.deepStrictEqual(acquired, [])
      assert.strictEqual(yield* Effect.scoped(RcMap.get(map, "foo")), "foo")
      assert.deepStrictEqual(acquired, ["foo"])
      assert.deepStrictEqual(released, ["foo"])

      const scopeA = yield* Scope.make()
      const scopeB = yield* Scope.make()
      yield* RcMap.get(map, "bar").pipe(Scope.provide(scopeA))
      yield* Effect.scoped(RcMap.get(map, "bar"))
      yield* RcMap.get(map, "baz").pipe(Scope.provide(scopeB))
      yield* Effect.scoped(RcMap.get(map, "baz"))
      assert.deepStrictEqual(acquired, ["foo", "bar", "baz"])
      assert.deepStrictEqual(released, ["foo"])
      yield* Scope.close(scopeB, Exit.void)
      assert.deepStrictEqual(acquired, ["foo", "bar", "baz"])
      assert.deepStrictEqual(released, ["foo", "baz"])
      yield* Scope.close(scopeA, Exit.void)
      assert.deepStrictEqual(acquired, ["foo", "bar", "baz"])
      assert.deepStrictEqual(released, ["foo", "baz", "bar"])

      const scopeC = yield* Scope.make()
      yield* RcMap.get(map, "qux").pipe(Scope.provide(scopeC))
      assert.deepStrictEqual(acquired, ["foo", "bar", "baz", "qux"])
      assert.deepStrictEqual(released, ["foo", "baz", "bar"])

      yield* Scope.close(mapScope, Exit.void)
      assert.deepStrictEqual(acquired, ["foo", "bar", "baz", "qux"])
      assert.deepStrictEqual(released, ["foo", "baz", "bar", "qux"])

      const exit = yield* RcMap.get(map, "boom").pipe(Effect.scoped, Effect.exit)
      assert.isTrue(Exit.hasInterrupts(exit))
    }))

  it.effect("idleTimeToLive", () =>
    Effect.gen(function*() {
      const acquired: Array<string> = []
      const released: Array<string> = []
      const map = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired.push(key)
              return key
            }),
            () => Effect.sync(() => released.push(key))
          ),
        idleTimeToLive: 1000
      })

      assert.deepStrictEqual(acquired, [])
      assert.strictEqual(yield* Effect.scoped(RcMap.get(map, "foo")), "foo")
      assert.deepStrictEqual(acquired, ["foo"])
      assert.deepStrictEqual(released, [])

      yield* TestClock.adjust(1000)
      assert.deepStrictEqual(released, ["foo"])

      assert.strictEqual(yield* Effect.scoped(RcMap.get(map, "bar")), "bar")
      assert.deepStrictEqual(acquired, ["foo", "bar"])
      assert.deepStrictEqual(released, ["foo"])

      yield* TestClock.adjust(500)
      assert.strictEqual(yield* Effect.scoped(RcMap.get(map, "bar")), "bar")
      assert.deepStrictEqual(acquired, ["foo", "bar"])
      assert.deepStrictEqual(released, ["foo"])

      yield* TestClock.adjust(1000)
      assert.deepStrictEqual(released, ["foo", "bar"])

      yield* Effect.scoped(RcMap.get(map, "baz"))
      assert.deepStrictEqual(acquired, ["foo", "bar", "baz"])
      yield* RcMap.invalidate(map, "baz")
      assert.deepStrictEqual(acquired, ["foo", "bar", "baz"])
      assert.deepStrictEqual(released, ["foo", "bar", "baz"])
    }))

  it.effect(".touch", () =>
    Effect.gen(function*() {
      const acquired: Array<string> = []
      const released: Array<string> = []
      const map = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired.push(key)
              return key
            }),
            () => Effect.sync(() => released.push(key))
          ),
        idleTimeToLive: 1000
      })

      assert.deepStrictEqual(acquired, [])
      assert.strictEqual(yield* Effect.scoped(RcMap.get(map, "foo")), "foo")
      assert.deepStrictEqual(acquired, ["foo"])
      assert.deepStrictEqual(released, [])

      yield* TestClock.adjust(500)
      assert.deepStrictEqual(released, [])

      yield* RcMap.touch(map, "foo")
      yield* TestClock.adjust(500)
      assert.deepStrictEqual(released, [])
      yield* TestClock.adjust(500)
      assert.deepStrictEqual(released, ["foo"])
    }))

  it.effect("capacity", () =>
    Effect.gen(function*() {
      const map = yield* RcMap.make({
        lookup: (key: string) => Effect.succeed(key),
        capacity: 2,
        idleTimeToLive: 1000
      })

      assert.strictEqual(yield* Effect.scoped(RcMap.get(map, "foo")), "foo")
      assert.strictEqual(yield* Effect.scoped(RcMap.get(map, "foo")), "foo")
      assert.strictEqual(yield* Effect.scoped(RcMap.get(map, "bar")), "bar")

      const exit = yield* RcMap.get(map, "baz").pipe(Effect.scoped, Effect.exit)
      assert.deepStrictEqual(
        exit,
        Exit.fail(new Cause.ExceededCapacityError(`RcMap attempted to exceed capacity of 2`))
      )

      yield* TestClock.adjust(1000)
      assert.strictEqual(yield* Effect.scoped(RcMap.get(map, "baz")), "baz")
    }))

  it.effect("complex key", () =>
    Effect.gen(function*() {
      class Key extends Data.Class<{ readonly id: number }> {}
      const map = yield* RcMap.make({
        lookup: (key: Key) => Effect.succeed(key.id),
        capacity: 1
      })

      assert.strictEqual(yield* RcMap.get(map, new Key({ id: 1 })), 1)
      // no failure means a hit
      assert.strictEqual(yield* RcMap.get(map, new Key({ id: 1 })), 1)
    }))

  it.effect("keys lookup", () =>
    Effect.gen(function*() {
      const map = yield* RcMap.make({
        lookup: (key: string) => Effect.succeed(key)
      })

      yield* RcMap.get(map, "foo")
      yield* RcMap.get(map, "bar")
      yield* RcMap.get(map, "baz")

      assert.deepStrictEqual(Array.from(yield* RcMap.keys(map)), ["foo", "bar", "baz"])
    }))

  it.effect("dynamic idleTimeToLive", () =>
    Effect.gen(function*() {
      const acquired: Array<string> = []
      const released: Array<string> = []
      const map = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired.push(key)
              return key
            }),
            () => Effect.sync(() => released.push(key))
          ),
        idleTimeToLive: (key: string) => key.startsWith("short:") ? 500 : 2000
      })

      assert.deepStrictEqual(acquired, [])

      yield* Effect.scoped(RcMap.get(map, "short:a"))
      yield* Effect.scoped(RcMap.get(map, "long:b"))
      assert.deepStrictEqual(acquired, ["short:a", "long:b"])
      assert.deepStrictEqual(released, [])

      yield* TestClock.adjust(500)
      assert.deepStrictEqual(released, ["short:a"])

      yield* TestClock.adjust(1500)
      assert.deepStrictEqual(released, ["short:a", "long:b"])
    }))

  it.effect("dynamic idleTimeToLive with touch", () =>
    Effect.gen(function*() {
      const acquired: Array<string> = []
      const released: Array<string> = []
      const map = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired.push(key)
              return key
            }),
            () => Effect.sync(() => released.push(key))
          ),
        idleTimeToLive: (key: string) => key.startsWith("short:") ? 500 : 2000
      })

      yield* Effect.scoped(RcMap.get(map, "short:a"))
      assert.deepStrictEqual(acquired, ["short:a"])
      assert.deepStrictEqual(released, [])

      yield* TestClock.adjust(250)
      yield* RcMap.touch(map, "short:a")
      yield* TestClock.adjust(250)
      assert.deepStrictEqual(released, [])

      yield* TestClock.adjust(250)
      assert.deepStrictEqual(released, ["short:a"])
    }))
})
