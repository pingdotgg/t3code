import { assert, describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Effect, Exit, identity, pipe, Ref, Scope, ScopedRef } from "effect"
import * as Counter from "./utils/counter.ts"

describe("ScopedRef", () => {
  it.effect("single set", () =>
    Effect.gen(function*() {
      const counter = yield* Counter.make()
      const ref = yield* ScopedRef.make(() => 0)
      yield* ScopedRef.set(ref, counter.acquire())
      const result = yield* (ScopedRef.get(ref))
      strictEqual(result, 1)
    }))
  it.effect("dual set", () =>
    Effect.gen(function*() {
      const counter = yield* Counter.make()
      const ref = yield* ScopedRef.make(() => 0)
      yield* pipe(
        ScopedRef.set(ref, counter.acquire()),
        Effect.andThen(ScopedRef.set(ref, counter.acquire()))
      )
      const result = yield* ScopedRef.get(ref)
      strictEqual(result, 2)
    }))
  it.effect("releases the previous resource when replaced", () =>
    Effect.gen(function*() {
      const counter = yield* Counter.make()
      const ref = yield* ScopedRef.make(() => 0)
      yield* pipe(
        ScopedRef.set(ref, counter.acquire()),
        Effect.andThen(ScopedRef.set(ref, counter.acquire()))
      )

      const acquired = yield* counter.acquired()
      const released = yield* counter.released()
      strictEqual(acquired, 2)
      strictEqual(released, 1)
    }))
  it.effect("releases each previous resource across multiple replacements", () =>
    Effect.gen(function*() {
      const counter = yield* Counter.make()
      const ref = yield* ScopedRef.make(() => 0)
      yield* (
        pipe(
          ScopedRef.set(ref, counter.acquire()),
          Effect.andThen(ScopedRef.set(ref, counter.acquire())),
          Effect.andThen(ScopedRef.set(ref, counter.acquire()))
        )
      )
      const acquired = yield* counter.acquired()
      const released = yield* counter.released()
      strictEqual(acquired, 3)
      strictEqual(released, 2)
    }))
  it.effect("releases the current resource when the scoped ref scope closes", () =>
    Effect.gen(function*() {
      const counter = yield* Counter.make()
      yield* pipe(
        ScopedRef.make(() => 0),
        Effect.flatMap((ref) =>
          pipe(
            ScopedRef.set(ref, counter.acquire()),
            Effect.andThen(ScopedRef.set(ref, counter.acquire())),
            Effect.andThen(ScopedRef.set(ref, counter.acquire()))
          )
        ),
        Effect.scoped
      )
      const acquired = yield* counter.acquired()
      const released = yield* counter.released()
      strictEqual(acquired, 3)
      strictEqual(released, 3)
    }))
  it.effect("keeps the current resource when replacement acquisition fails", () =>
    Effect.gen(function*() {
      let released = false
      const ref = yield* ScopedRef.fromAcquire(
        Effect.acquireRelease(Effect.succeed(1), () =>
          Effect.sync(() => {
            released = true
          }))
      )

      yield* ScopedRef.set(ref, Effect.fail("boom")).pipe(Effect.catch(() => Effect.void))

      strictEqual(released, false, "failed replacement must not release the current resource")
      strictEqual(yield* ScopedRef.get(ref), 1)
    }))
  it.effect("releases a replacement when the old finalizer defects", () =>
    Effect.gen(function*() {
      const oldReleased = yield* Ref.make(0)
      const replacementAcquired = yield* Ref.make(0)
      const replacementReleased = yield* Ref.make(0)
      const ownerScope = yield* Scope.make()
      const ref = yield* ScopedRef.fromAcquire(
        Effect.acquireRelease(
          Effect.succeed(0),
          () =>
            Ref.update(oldReleased, (n) => n + 1).pipe(
              Effect.andThen(Effect.die("old-release-defect"))
            )
        )
      ).pipe(Scope.provide(ownerScope))

      const setExit = yield* ScopedRef.set(
        ref,
        Effect.acquireRelease(
          Ref.updateAndGet(replacementAcquired, (n) => n + 1),
          () => Ref.update(replacementReleased, (n) => n + 1)
        )
      ).pipe(Effect.exit)
      strictEqual(yield* ScopedRef.get(ref), 0)
      const ownerCloseExit = yield* Scope.close(ownerScope, Exit.void).pipe(Effect.exit)

      assert.deepStrictEqual(setExit, Exit.die("old-release-defect"))
      assert.deepStrictEqual(ownerCloseExit, Exit.void)
      strictEqual(yield* Ref.get(oldReleased), 1)
      strictEqual(yield* Ref.get(replacementAcquired), 1)
      strictEqual(yield* Ref.get(replacementReleased), 1)
    }))
  it.effect("fromAcquire tracks the initial resource through replacement and scope close", () =>
    Effect.gen(function*() {
      const ref = yield* Effect.scoped(ScopedRef.make(() => 0))
      strictEqual(ref.pipe(identity), ref)
    }))
})
