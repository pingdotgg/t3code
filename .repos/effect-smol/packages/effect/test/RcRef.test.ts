import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as RcRef from "effect/RcRef"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"

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

  it.effect("releasing an invalidated borrower preserves the replacement resource", () =>
    Effect.gen(function*() {
      let acquired = 0
      const released: Array<number> = []
      const owner = yield* Scope.make()
      const scopeA = yield* Scope.make()
      const scopeB = yield* Scope.make()
      const scopeC = yield* Scope.make()
      const ref = yield* RcRef.make({
        acquire: Effect.acquireRelease(
          Effect.sync(() => ++acquired),
          (id) => Effect.sync(() => released.push(id))
        )
      }).pipe(Scope.provide(owner))

      const first = yield* RcRef.get(ref).pipe(Scope.provide(scopeA))
      yield* RcRef.invalidate(ref)
      const replacement = yield* RcRef.get(ref).pipe(Scope.provide(scopeB))
      yield* Scope.close(scopeA, Exit.void)
      const next = yield* RcRef.get(ref).pipe(Scope.provide(scopeC))
      yield* Scope.close(owner, Exit.void)
      const releasedAtOwnerClose = [...released]
      yield* Scope.close(scopeB, Exit.void)
      yield* Scope.close(scopeC, Exit.void)

      assert.deepStrictEqual(
        { first, replacement, next, releasedAtOwnerClose, released },
        { first: 1, replacement: 2, next: 2, releasedAtOwnerClose: [1, 2], released: [1, 2] }
      )
    }))

  it.effect("releasing a borrower after owner shutdown does not reopen the reference", () =>
    Effect.gen(function*() {
      let acquired = 0
      const owner = yield* Scope.make()
      const borrower = yield* Scope.make()
      const ref = yield* RcRef.make({
        acquire: Effect.sync(() => ++acquired)
      }).pipe(Scope.provide(owner))

      yield* RcRef.get(ref).pipe(Scope.provide(borrower))
      yield* Scope.close(owner, Exit.void)
      yield* Scope.close(borrower, Exit.void)
      const exit = yield* RcRef.get(ref).pipe(Effect.scoped, Effect.exit)

      assert.isTrue(Exit.hasInterrupts(exit))
      assert.strictEqual(acquired, 1)
    }))

  it.effect("acquisition completing after owner shutdown cannot reopen the reference", () =>
    Effect.gen(function*() {
      const owner = yield* Scope.make()
      const borrower = yield* Scope.make()
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const released: Array<number> = []
      const ref = yield* RcRef.make({
        acquire: Effect.gen(function*() {
          const value = yield* Effect.acquireRelease(
            Effect.succeed(1),
            (value) => Effect.sync(() => released.push(value))
          )
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(finish)
          return value
        })
      }).pipe(Scope.provide(owner))
      const pending = yield* RcRef.get(ref).pipe(
        Scope.provide(borrower),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(started)
      const queued = yield* RcRef.get(ref).pipe(
        Scope.provide(borrower),
        Effect.forkChild({ startImmediately: true })
      )

      yield* Scope.close(owner, Exit.void)
      const before = yield* RcRef.get(ref).pipe(Effect.scoped, Effect.exit)
      yield* Deferred.succeed(finish, undefined)
      const pendingExit = yield* Fiber.await(pending)
      const queuedExit = yield* Fiber.await(queued)
      const after = yield* RcRef.get(ref).pipe(Effect.scoped, Effect.exit)
      const releasedBeforeBorrowerClose = [...released]
      yield* Scope.close(borrower, Exit.void)

      assert.isTrue(Exit.hasInterrupts(before))
      assert.isTrue(Exit.hasInterrupts(pendingExit))
      assert.isTrue(Exit.hasInterrupts(queuedExit))
      assert.isTrue(Exit.hasInterrupts(after))
      assert.deepStrictEqual(releasedBeforeBorrowerClose, [1])
      assert.deepStrictEqual(released, [1])
    }))

  it.effect("releases resources acquired before acquisition failure", () =>
    Effect.gen(function*() {
      const acquired = yield* Ref.make(0)
      const released = yield* Ref.make(0)
      const refScope = yield* Scope.make()
      const borrowerScope = yield* Scope.make()
      const ref = yield* RcRef.make({
        acquire: Effect.acquireRelease(
          Ref.updateAndGet(acquired, (n) => n + 1),
          () => Ref.update(released, (n) => n + 1)
        ).pipe(Effect.andThen(Effect.fail("boom")))
      }).pipe(Scope.provide(refScope))

      const getExit = yield* RcRef.get(ref).pipe(Scope.provide(borrowerScope), Effect.exit)
      const borrowerCloseExit = yield* Scope.close(borrowerScope, Exit.void).pipe(Effect.exit)
      const refCloseExit = yield* Scope.close(refScope, Exit.void).pipe(Effect.exit)

      assert.deepStrictEqual(getExit, Exit.fail("boom"))
      assert.deepStrictEqual(borrowerCloseExit, Exit.void)
      assert.deepStrictEqual(refCloseExit, Exit.void)
      assert.strictEqual(yield* Ref.get(acquired), 1)
      assert.strictEqual(yield* Ref.get(released), 1)
    }))

  it.effect("shares one generation between concurrent first borrowers", () =>
    Effect.gen(function*() {
      const acquired = yield* Ref.make(0)
      const released = yield* Ref.make(0)
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const refScope = yield* Scope.make()
      const scopeA = yield* Scope.make()
      const scopeB = yield* Scope.make()
      const ref = yield* RcRef.make({
        acquire: Effect.acquireRelease(
          Effect.gen(function*() {
            const id = yield* Ref.updateAndGet(acquired, (n) => n + 1)
            if (id === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(releaseFirst)
            }
            return { id }
          }),
          () => Ref.update(released, (n) => n + 1)
        )
      }).pipe(Scope.provide(refScope))

      const fiberA = yield* RcRef.get(ref).pipe(
        Scope.provide(scopeA),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(firstStarted)
      const fiberB = yield* RcRef.get(ref).pipe(
        Scope.provide(scopeB),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.succeed(releaseFirst, undefined)

      const exitA = yield* Fiber.await(fiberA)
      const exitB = yield* Fiber.await(fiberB)
      const generationA = yield* Fiber.join(fiberA)
      const generationB = yield* Fiber.join(fiberB)
      const closeAExit = yield* Scope.close(scopeA, Exit.void).pipe(Effect.exit)
      const closeBExit = yield* Scope.close(scopeB, Exit.void).pipe(Effect.exit)
      const refCloseExit = yield* Scope.close(refScope, Exit.void).pipe(Effect.exit)

      assert.deepStrictEqual(
        {
          exitA,
          exitB,
          closeAExit,
          closeBExit,
          refCloseExit,
          sameGeneration: generationA === generationB,
          acquired: yield* Ref.get(acquired),
          released: yield* Ref.get(released)
        },
        {
          exitA: Exit.succeed(generationA),
          exitB: Exit.succeed(generationA),
          closeAExit: Exit.void,
          closeBExit: Exit.void,
          refCloseExit: Exit.void,
          sameGeneration: true,
          acquired: 1,
          released: 1
        }
      )
    }))

  it.effect("idleTimeToLive reuses and releases resources", () =>
    Effect.gen(function*() {
      let acquired = 0
      let released = 0
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
        ),
        idleTimeToLive: "10 millis"
      })

      assert.strictEqual(acquired, 0)
      assert.strictEqual(yield* Effect.scoped(RcRef.get(ref)), "foo")
      assert.strictEqual(acquired, 1)
      assert.strictEqual(released, 0)

      yield* TestClock.adjust("5 millis")
      assert.strictEqual(yield* Effect.scoped(RcRef.get(ref)), "foo")
      assert.strictEqual(acquired, 1)
      assert.strictEqual(released, 0)

      yield* TestClock.adjust("9 millis")
      assert.strictEqual(released, 0)
      yield* TestClock.adjust("1 millis")
      assert.strictEqual(released, 1)

      assert.strictEqual(yield* Effect.scoped(RcRef.get(ref)), "foo")
      assert.strictEqual(acquired, 2)
      assert.strictEqual(released, 1)

      yield* TestClock.adjust("10 millis")
      assert.strictEqual(released, 2)
    }))
})
