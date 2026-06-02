import { assert, describe, it } from "@effect/vitest"
import { Deferred, Option } from "effect"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"

describe("Deferred", () => {
  describe("success", () => {
    it.effect("succeed - should propagate the value", () =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<number>()
        assert.isTrue(yield* Deferred.succeed(deferred, 1))
        assert.isFalse(yield* Deferred.succeed(deferred, 1))
        assert.strictEqual(yield* Deferred.await(deferred), 1)
      }))

    it.effect("complete - should memoize the result of the provided effect", () =>
      Effect.gen(function*() {
        let value = 0
        const complete = Effect.sync(() => {
          value += 1
          return value
        })
        const deferred = yield* Deferred.make<number>()
        assert.isTrue(yield* Deferred.complete(deferred, complete))
        assert.isFalse(yield* Deferred.complete(deferred, complete))
        assert.strictEqual(value, 1)
        assert.strictEqual(yield* Deferred.await(deferred), 1)
        assert.strictEqual(yield* Deferred.await(deferred), 1)
        assert.strictEqual(value, 1)
      }))

    it.effect("completeWith - should not memoize the provided effect", () =>
      Effect.gen(function*() {
        let value = 0
        const complete = Effect.sync(() => {
          value += 1
          return value
        })
        const complete2 = Effect.sync(() => {
          value += 10
          return value
        })
        const deferred = yield* Deferred.make<number>()
        assert.isTrue(yield* Deferred.completeWith(deferred, complete))
        assert.isFalse(yield* Deferred.completeWith(deferred, complete2))
        assert.strictEqual(value, 0)
        assert.strictEqual(yield* Deferred.await(deferred), 1)
        assert.strictEqual(yield* Deferred.await(deferred), 2)
        assert.strictEqual(value, 2)
      }))
  })

  describe("failure", () => {
    it.effect("fail - should propagate the failure", () =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<number, string>()
        assert.isTrue(yield* Deferred.fail(deferred, "boom"))
        assert.isFalse(yield* Deferred.succeed(deferred, 1))
        const result = yield* Effect.exit(Deferred.await(deferred))
        assert.deepStrictEqual(result, Exit.fail("boom"))
      }))

    it.effect("complete - should memoize the failure of the provided effect", () =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<number, string>()
        assert.isTrue(yield* Deferred.complete(deferred, Effect.fail("boom")))
        assert.isFalse(yield* Deferred.complete(deferred, Effect.fail("boom2")))
        const result1 = yield* Effect.exit(Deferred.await(deferred))
        const result2 = yield* Effect.exit(Deferred.await(deferred))
        assert.deepStrictEqual(result1, Exit.fail("boom"))
        assert.deepStrictEqual(result2, Exit.fail("boom"))
      }))

    it.effect("completeWith - should memoize the provided effect", () =>
      Effect.gen(function*() {
        let i = 0
        const failures = ["boom", "boom2"]
        const complete = Effect.failSync(() => failures[i++])
        const complete2 = Effect.failSync(() => "boom3")
        const deferred = yield* Deferred.make<number, string>()
        assert.isTrue(yield* Deferred.completeWith(deferred, complete))
        assert.isFalse(yield* Deferred.completeWith(deferred, complete2))
        const result = yield* Effect.exit(Deferred.await(deferred))
        const result2 = yield* Effect.exit(Deferred.await(deferred))
        assert.deepStrictEqual(result, Exit.fail("boom"))
        assert.deepStrictEqual(result2, Exit.fail("boom2"))
      }))
  })

  describe("interruption", () => {
    it.effect("interrupt - should propagate the interruption", () =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<number>()
        assert.isTrue(yield* Deferred.interruptWith(deferred, -1))
        assert.isFalse(yield* Deferred.interrupt(deferred))
        const result = yield* Effect.exit(Deferred.await(deferred))
        assert.deepStrictEqual(result, Exit.failCause(Cause.interrupt(-1)))
      }))
  })

  describe("polling", () => {
    it.effect("poll - should return Option.none when the deferred is incomplete", () =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<number>()
        const result = yield* Deferred.poll(deferred)
        assert.deepStrictEqual(result, Option.none())
      }))

    it.effect("poll - should return Option.some when the deferred was completed", () =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<number>()
        yield* Deferred.succeed(deferred, 1)
        const polled = yield* Deferred.poll(deferred)
        if (Option.isNone(polled)) {
          assert.fail("expected Option.some")
          return
        }
        const result = yield* polled.value
        assert.deepStrictEqual(result, 1)
      }))

    it.effect("poll - should return Option.some when the deferred was failed", () =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<number, string>()
        yield* Deferred.fail(deferred, "boom")
        const polled = yield* Deferred.poll(deferred)
        if (Option.isNone(polled)) {
          assert.fail("expected Option.some")
          return
        }
        const result = yield* Effect.exit(polled.value)
        assert.deepStrictEqual(result, Exit.fail("boom"))
      }))

    it.effect("poll - should return Option.some when the deferred was interrupted", () =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<number, string>()
        yield* Deferred.interruptWith(deferred, -1)
        const polled = yield* Deferred.poll(deferred)
        if (Option.isNone(polled)) {
          assert.fail("expected Option.some")
          return
        }
        const result = yield* Effect.exit(polled.value)
        assert.deepStrictEqual(result, Exit.failCause(Cause.interrupt(-1)))
      }))
  })

  describe("done", () => {
    it.effect("isDone - should return true when suceeded", () =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<number>()
        yield* Deferred.succeed(deferred, 1)
        assert.isTrue(yield* Deferred.isDone(deferred))
      }))

    it.effect("isDone - should return true when failed", () =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<number, string>()
        yield* Deferred.fail(deferred, "boom")
        assert.isTrue(yield* Deferred.isDone(deferred))
      }))
  })
})
