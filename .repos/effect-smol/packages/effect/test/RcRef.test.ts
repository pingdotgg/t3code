import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as RcRef from "effect/RcRef"
import * as Scope from "effect/Scope"

describe("RcRef", () => {
  it.effect("deallocation", () =>
    Effect.gen(function*() {
      let acquired = 0
      let released = 0
      const refScope = yield* Scope.make()
      const ref = yield* RcRef.make({
        acquire: Effect.acquireRelease(
          Effect.sync(() => {
            acquired++
            return "foo"
          }),
          () =>
            Effect.sync(() => {
              released++
            })
        )
      }).pipe(
        Scope.provide(refScope)
      )

      assert.strictEqual(acquired, 0)
      assert.strictEqual(yield* Effect.scoped(RcRef.get(ref)), "foo")
      assert.strictEqual(acquired, 1)
      assert.strictEqual(released, 1)

      const scopeA = yield* Scope.make()
      const scopeB = yield* Scope.make()
      yield* RcRef.get(ref).pipe(Scope.provide(scopeA))
      yield* RcRef.get(ref).pipe(Scope.provide(scopeB))
      assert.strictEqual(acquired, 2)
      assert.strictEqual(released, 1)
      yield* Scope.close(scopeB, Exit.void)
      assert.strictEqual(acquired, 2)
      assert.strictEqual(released, 1)
      yield* Scope.close(scopeA, Exit.void)
      assert.strictEqual(acquired, 2)
      assert.strictEqual(released, 2)

      const scopeC = yield* Scope.make()
      yield* RcRef.get(ref).pipe(Scope.provide(scopeC))
      assert.strictEqual(acquired, 3)
      assert.strictEqual(released, 2)

      yield* Scope.close(refScope, Exit.void)
      assert.strictEqual(acquired, 3)
      assert.strictEqual(released, 3)

      const exit = yield* RcRef.get(ref).pipe(Effect.scoped, Effect.exit)
      assert.isTrue(Exit.hasInterrupts(exit))
    }))

  // it.scoped("idleTimeToLive", () =>
  //   Effect.gen(function*() {
  //     let acquired = 0
  //     let released = 0
  //     const ref = yield* RcRef.make({
  //       acquire: Effect.acquireRelease(
  //         Effect.sync(() => {
  //           acquired++
  //           return "foo"
  //         }),
  //         () =>
  //           Effect.sync(() => {
  //             released++
  //           })
  //       ),
  //       idleTimeToLive: 1000
  //     })
  //
  //     assert.strictEqual(acquired, 0)
  //     assert.strictEqual(yield* Effect.scoped(RcRef.get(ref)), "foo")
  //     assert.strictEqual(acquired, 1)
  //     assert.strictEqual(released, 0)
  //
  //     yield* TestClock.adjust(1000)
  //     assert.strictEqual(released, 1)
  //
  //     assert.strictEqual(yield* Effect.scoped(RcRef.get(ref)), "foo")
  //     assert.strictEqual(acquired, 2)
  //     assert.strictEqual(released, 1)
  //
  //     yield* TestClock.adjust(500)
  //     assert.strictEqual(yield* Effect.scoped(RcRef.get(ref)), "foo")
  //     assert.strictEqual(acquired, 2)
  //     assert.strictEqual(released, 1)
  //
  //     yield* TestClock.adjust(1000)
  //     assert.strictEqual(released, 2)
  //   }))
})
