import { afterAll, assert, describe, expect, it, layer } from "@effect/vitest"
import { Clock, Context, Duration, Effect, Fiber, Layer } from "effect"
import { FastCheck, TestClock } from "effect/testing"

it.effect(
  "effect",
  () => Effect.acquireRelease(Effect.sync(() => expect(1).toEqual(1)), () => Effect.void)
)
it.live(
  "live",
  () => Effect.acquireRelease(Effect.sync(() => expect(1).toEqual(1)), () => Effect.void)
)

// each

it.effect.each([1, 2, 3])(
  "effect each %s",
  (n) => Effect.acquireRelease(Effect.sync(() => expect(n).toEqual(n)), () => Effect.void)
)
it.live.each([1, 2, 3])(
  "live each %s",
  (n) => Effect.acquireRelease(Effect.sync(() => expect(n).toEqual(n)), () => Effect.void)
)

// skip

it.live.skip(
  "live skipped",
  () => Effect.die("skipped anyway")
)
it.effect.skip(
  "effect skipped",
  () => Effect.die("skipped anyway")
)

// skipIf

it.effect.skipIf(true)("effect skipIf (true)", () => Effect.die("skipped anyway"))
it.effect.skipIf(false)("effect skipIf (false)", () => Effect.sync(() => expect(1).toEqual(1)))

// runIf

it.effect.runIf(true)("effect runIf (true)", () => Effect.sync(() => expect(1).toEqual(1)))
it.effect.runIf(false)("effect runIf (false)", () => Effect.die("not run anyway"))

// The following test is expected to fail because it simulates a test timeout.
// Be aware that eventual "failure" of the test is only logged out.
it.live.fails("interrupts on timeout", (ctx) =>
  Effect.gen(function*() {
    let acquired = false

    ctx.onTestFailed(() => {
      if (acquired) {
        // oxlint-disable-next-line no-console
        console.error("'effect is interrupted on timeout' @effect/vitest test failed")
      }
    })

    yield* Effect.acquireRelease(
      Effect.sync(() => acquired = true),
      () => Effect.sync(() => acquired = false)
    )
    yield* Effect.sleep(1000)
  }), 1)

class Foo extends Context.Service<Foo, "foo">()("Foo") {
  static Live = Layer.succeed(Foo)("foo")
}

class Bar extends Context.Service<Bar, "bar">()("Bar") {
  static Live = Layer.effect(Bar)(Effect.map(Foo, () => "bar" as const))
}

class Sleeper extends Context.Service<Sleeper, {
  readonly sleep: (ms: number) => Effect.Effect<void>
}>()("Sleeper") {
  static readonly layer = Layer.effect(Sleeper)(
    Effect.gen(function*() {
      const clock = yield* Clock.Clock

      return {
        sleep: (ms: number) => clock.sleep(Duration.millis(ms))
      }
    })
  )
}

describe("layer", () => {
  layer(Foo.Live)((it) => {
    it.effect("adds context", () =>
      Effect.gen(function*() {
        const foo = yield* Foo
        expect(foo).toEqual("foo")
      }))

    it.layer(Bar.Live)("nested", (it) => {
      it.effect("adds context", () =>
        Effect.gen(function*() {
          const foo = yield* Foo
          const bar = yield* Bar
          expect(foo).toEqual("foo")
          expect(bar).toEqual("bar")
        }))
    })

    it.layer(Bar.Live)((it) => {
      it.effect("without name", () =>
        Effect.gen(function*() {
          const foo = yield* Foo
          const bar = yield* Bar
          expect(foo).toEqual("foo")
          expect(bar).toEqual("bar")
        }))
    })

    describe("release", () => {
      let released = false
      afterAll(() => {
        expect(released).toEqual(true)
      })

      class Scoped extends Context.Service<Scoped, "scoped">()("Scoped") {
        static Live = Layer.effect(Scoped)(
          Effect.acquireRelease(
            Effect.succeed("scoped" as const),
            () => Effect.sync(() => released = true)
          )
        )
      }

      it.layer(Scoped.Live)((it) => {
        it.effect("adds context", () =>
          Effect.gen(function*() {
            const foo = yield* Foo
            const scoped = yield* Scoped
            expect(foo).toEqual("foo")
            expect(scoped).toEqual("scoped")
          }))
      })

      it.effect.prop(
        "adds context",
        [realNumber],
        ([num]) =>
          Effect.gen(function*() {
            const foo = yield* Foo
            expect(foo).toEqual("foo")
            return num === num
          }),
        { fastCheck: { numRuns: 200 } }
      )
    })
  })

  layer(Sleeper.layer)("test services", (it) => {
    it.effect("TestClock", () =>
      Effect.gen(function*() {
        const sleeper = yield* Sleeper
        const fiber = yield* Effect.forkChild(sleeper.sleep(100_000))
        yield* Effect.yieldNow
        yield* TestClock.adjust(100_000)
        yield* Fiber.join(fiber)
      }))
  })

  layer(Foo.Live)("with a name", (it) => {
    describe("with a nested describe", () => {
      it.effect("adds context", () =>
        Effect.gen(function*() {
          const foo = yield* Foo
          expect(foo).toEqual("foo")
        }))
    })
    it.effect("adds context", () =>
      Effect.gen(function*() {
        const foo = yield* Foo
        expect(foo).toEqual("foo")
      }))
  })

  layer(Sleeper.layer, { excludeTestServices: true })("live services", (it) => {
    it.effect("Clock", () =>
      Effect.gen(function*() {
        const sleeper = yield* Sleeper
        yield* sleeper.sleep(1)
      }))
  })
})

// property testing

const realNumber = FastCheck.float({ noNaN: true, noDefaultInfinity: true })

it.prop("symmetry", [realNumber, FastCheck.integer()], ([a, b]) => a + b === b + a)

it.prop(
  "symmetry with object",
  { a: realNumber, b: FastCheck.integer() },
  ({ a, b }) => a + b === b + a
)

it.effect.prop("symmetry", [realNumber, FastCheck.integer()], ([a, b]) =>
  Effect.gen(function*() {
    yield* Effect.void
    assert.isTrue(a + b === b + a)
  }))

it.effect.prop("symmetry with object", { a: realNumber, b: FastCheck.integer() }, ({ a, b }) =>
  Effect.gen(function*() {
    yield* Effect.void
    assert.strictEqual(a + b, b + a)
  }))

it.effect.prop(
  "should detect the substring",
  { a: FastCheck.string(), b: FastCheck.string(), c: FastCheck.string() },
  ({ a, b, c }) =>
    Effect.gen(function*() {
      yield* Effect.scope
      assert.include(a + b + c, b)
    })
)
