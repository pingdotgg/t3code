import { describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Effect, identity, pipe, ScopedRef } from "effect"
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
  it.effect("fromAcquire tracks the initial resource through replacement and scope close", () =>
    Effect.gen(function*() {
      const ref = yield* Effect.scoped(ScopedRef.make(() => 0))
      strictEqual(ref.pipe(identity), ref)
    }))
})
