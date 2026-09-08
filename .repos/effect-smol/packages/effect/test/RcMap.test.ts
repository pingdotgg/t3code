import { assert, describe, it } from "@effect/vitest"
import { Cause, Data, Deferred, Effect, Exit, Fiber, Option, RcMap, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"

describe("RcMap", () => {
  describe("getOption", () => {
    it.effect("returns None without lookup or capacity acquisition when missing", () =>
      Effect.gen(function*() {
        const lookups = yield* Ref.make(0)
        const map = yield* RcMap.make({
          lookup: (key: string) => Ref.update(lookups, (n) => n + 1).pipe(Effect.as(key)),
          capacity: 0
        })

        assert.deepStrictEqual(yield* RcMap.getOption(map, "missing"), Option.none())
        assert.deepStrictEqual(yield* RcMap.getOption("missing")(map), Option.none())
        assert.strictEqual(yield* Ref.get(lookups), 0)
      }))

    it.effect("retains a ready entry until the caller scope closes", () =>
      Effect.gen(function*() {
        const released = yield* Ref.make(0)
        const map = yield* RcMap.make({
          lookup: (key: string) =>
            Effect.acquireRelease(
              Effect.succeed(key),
              () => Ref.update(released, (n) => n + 1)
            )
        })
        const ownerScope = yield* Scope.make()
        const borrowerScope = yield* Scope.make()

        yield* RcMap.get(map, "ready").pipe(Scope.provide(ownerScope))
        assert.deepStrictEqual(
          yield* RcMap.getOption("ready")(map).pipe(Scope.provide(borrowerScope)),
          Option.some("ready")
        )

        yield* Scope.close(ownerScope, Exit.void)
        assert.strictEqual(yield* Ref.get(released), 0)
        yield* Scope.close(borrowerScope, Exit.void)
        assert.strictEqual(yield* Ref.get(released), 1)
      }))

    it.effect("shares an in-flight entry", () =>
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const complete = yield* Deferred.make<void>()
        const released = yield* Ref.make(0)
        const map = yield* RcMap.make({
          lookup: (key: string) =>
            Effect.acquireRelease(
              Deferred.succeed(started, void 0).pipe(
                Effect.andThen(Deferred.await(complete)),
                Effect.as(key)
              ),
              () => Ref.update(released, (n) => n + 1)
            )
        })
        const ownerScope = yield* Scope.make()
        const borrowerScope = yield* Scope.make()
        const owner = yield* RcMap.get(map, "pending").pipe(
          Scope.provide(ownerScope),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(started)
        const borrower = yield* RcMap.getOption(map, "pending").pipe(
          Scope.provide(borrowerScope),
          Effect.forkChild({ startImmediately: true })
        )

        assert.strictEqual(map.state._tag === "Open" ? Array.from(map.state.map)[0][1].refCount : 0, 2)
        yield* Deferred.succeed(complete, void 0)
        assert.strictEqual(yield* Fiber.join(owner), "pending")
        assert.deepStrictEqual(yield* Fiber.join(borrower), Option.some("pending"))

        yield* Scope.close(ownerScope, Exit.void)
        assert.strictEqual(yield* Ref.get(released), 0)
        yield* Scope.close(borrowerScope, Exit.void)
        assert.strictEqual(yield* Ref.get(released), 1)
      }))

    it.effect("propagates a cached failure", () =>
      Effect.gen(function*() {
        const lookups = yield* Ref.make(0)
        const map = yield* RcMap.make({
          lookup: (_key: string) => Ref.update(lookups, (n) => n + 1).pipe(Effect.andThen(Effect.fail("boom")))
        })
        const ownerScope = yield* Scope.make()
        const borrowerScope = yield* Scope.make()

        assert.deepStrictEqual(
          yield* RcMap.get(map, "failed").pipe(Scope.provide(ownerScope), Effect.exit),
          Exit.fail("boom")
        )
        assert.deepStrictEqual(
          yield* RcMap.getOption(map, "failed").pipe(Scope.provide(borrowerScope), Effect.exit),
          Exit.fail("boom")
        )
        assert.strictEqual(yield* Ref.get(lookups), 1)

        yield* Scope.close(ownerScope, Exit.void)
        yield* Scope.close(borrowerScope, Exit.void)
      }))

    it.effect("retains an idle entry and restarts its TTL on release", () =>
      Effect.gen(function*() {
        const released = yield* Ref.make(0)
        const map = yield* RcMap.make({
          lookup: (key: string) =>
            Effect.acquireRelease(
              Effect.succeed(key),
              () => Ref.update(released, (n) => n + 1)
            ),
          idleTimeToLive: 1000
        })
        const ownerScope = yield* Scope.make()
        yield* RcMap.get(map, "ttl").pipe(Scope.provide(ownerScope))
        yield* Scope.close(ownerScope, Exit.void)

        yield* TestClock.adjust(500)
        const borrowerScope = yield* Scope.make()
        assert.deepStrictEqual(
          yield* RcMap.getOption(map, "ttl").pipe(Scope.provide(borrowerScope)),
          Option.some("ttl")
        )
        yield* TestClock.adjust(500)
        assert.strictEqual(yield* Ref.get(released), 0)

        yield* Scope.close(borrowerScope, Exit.void)
        yield* TestClock.adjust(999)
        assert.strictEqual(yield* Ref.get(released), 0)
        yield* TestClock.adjust(1)
        assert.strictEqual(yield* Ref.get(released), 1)
        assert.deepStrictEqual(yield* RcMap.getOption(map, "ttl"), Option.none())
      }))

    it.effect("linearizes retention before invalidation", () =>
      Effect.gen(function*() {
        const released = yield* Ref.make(0)
        const map = yield* RcMap.make({
          lookup: (key: string) =>
            Effect.acquireRelease(
              Effect.succeed(key),
              () => Ref.update(released, (n) => n + 1)
            )
        })
        const ownerScope = yield* Scope.make()
        const borrowerScope = yield* Scope.make()
        yield* RcMap.get(map, "key").pipe(Scope.provide(ownerScope))
        assert.deepStrictEqual(
          yield* RcMap.getOption(map, "key").pipe(Scope.provide(borrowerScope)),
          Option.some("key")
        )

        yield* RcMap.invalidate(map, "key")
        assert.isFalse(yield* RcMap.has(map, "key"))
        yield* Scope.close(ownerScope, Exit.void)
        assert.strictEqual(yield* Ref.get(released), 0)
        yield* Scope.close(borrowerScope, Exit.void)
        assert.strictEqual(yield* Ref.get(released), 1)
      }))

    it.effect("returns None when the map is closed", () =>
      Effect.gen(function*() {
        const mapScope = yield* Scope.make()
        const map = yield* RcMap.make({
          lookup: (key: string) => Effect.succeed(key)
        }).pipe(Scope.provide(mapScope))
        yield* Scope.close(mapScope, Exit.void)

        assert.deepStrictEqual(yield* RcMap.getOption(map, "key"), Option.none())
      }))
  })

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
