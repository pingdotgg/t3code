import { assert, describe, it, vi } from "@effect/vitest"
import { assertExitFailure } from "@effect/vitest/utils"
import {
  Cause,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  type Filter,
  Layer,
  Logger,
  type LogLevel,
  Option,
  References,
  Result,
  Schedule,
  Scope,
  TxRef
} from "effect"
import { constFalse, constTrue, pipe } from "effect/Function"
import { TestClock } from "effect/testing"
import { assertCauseFail } from "./utils/assert.ts"

class ATag extends Context.Service<ATag, "A">()("ATag") {}

describe("Effect", () => {
  it("isEffect", () => {
    assert.isTrue(Effect.isEffect(Effect.succeed(0)))
    assert.isFalse(Effect.isEffect([0]))
  })

  describe("structural compare", () => {
    it("should pass structural comparison", () => {
      assert.deepEqual(Effect.succeed(0), Effect.succeed(0))
    })
    it("should fail structural comparison", () => {
      assert.notDeepEqual(Effect.succeed(0), Effect.succeed(1))
    })
  })

  describe("tracing", () => {
    it.effect("failCause captures stack frame", () =>
      Effect.gen(function*() {
        const cause = yield* Effect.failCause(Cause.die(new Error("boom"))).pipe(
          Effect.withSpan("test span"),
          Effect.sandbox,
          Effect.flip
        )
        const annotations = Cause.annotations(cause)
        const trace = Context.getUnsafe(annotations, Cause.StackTrace)
        assert.strictEqual(trace.name, "test span")
      }))
  })

  it("callback can branch over sync/async", async () => {
    const program = Effect.callback<number>(function(resume) {
      if (this.executionMode === "sync") {
        resume(Effect.succeed(1))
      } else {
        Promise.resolve().then(() => resume(Effect.succeed(2)))
      }
    })

    const isSync = Effect.runSync(program)
    const isAsync = await Effect.runPromise(program)

    assert.strictEqual(isSync, 1)
    assert.strictEqual(isAsync, 2)
  })

  it("runPromise", async () => {
    const result = await Effect.runPromise(Effect.succeed(1))
    assert.strictEqual(result, 1)
  })

  it("acquireUseRelease interrupt", async () => {
    let acquire = false
    let use = false
    let release = false
    const fiber = Effect.acquireUseRelease(
      Effect.sync(() => {
        acquire = true
        return 123
      }).pipe(Effect.delay(100)),
      () =>
        Effect.sync(() => {
          use = true
        }),
      (_) =>
        Effect.sync(() => {
          assert.strictEqual(_, 123)
          release = true
        })
    ).pipe(Effect.runFork)
    fiber.interruptUnsafe()
    const result = await Effect.runPromise(Fiber.await(fiber))
    assert.deepStrictEqual(result, Exit.failCause(Cause.interrupt()))
    assert.isTrue(acquire)
    assert.isFalse(use)
    assert.isTrue(release)
  })

  it("acquireUseRelease uninterruptible", async () => {
    let acquire = false
    let use = false
    let release = false
    const fiber = Effect.acquireUseRelease(
      Effect.sync(() => {
        acquire = true
        return 123
      }).pipe(Effect.delay(100)),
      (_) =>
        Effect.sync(() => {
          use = true
          return _
        }),
      (_) =>
        Effect.sync(() => {
          assert.strictEqual(_, 123)
          release = true
        })
    ).pipe(Effect.uninterruptible, Effect.runFork)
    fiber.interruptUnsafe()
    const result = await Effect.runPromise(Fiber.await(fiber))
    assert.deepStrictEqual(result, Exit.failCause(Cause.interrupt()))
    assert.isTrue(acquire)
    assert.isTrue(use)
    assert.isTrue(release)
  })

  it("Context.Service", () =>
    ATag.pipe(
      Effect.tap((_) => Effect.sync(() => assert.strictEqual(_, "A"))),
      Effect.provideService(ATag, "A"),
      Effect.runPromise
    ))

  describe("fromOption", () => {
    it("from a some", () =>
      Option.some("A").pipe(
        Effect.fromOption,
        Effect.tap((_) => Effect.sync(() => assert.strictEqual(_, "A"))),
        Effect.runPromise
      ))

    it("from a none", () =>
      Option.none().pipe(
        Effect.fromOption,
        Effect.flip,
        Effect.tap((error) => Effect.sync(() => assert.ok(error instanceof Cause.NoSuchElementError))),
        Effect.runPromise
      ))
  })

  describe("fromResult", () => {
    it("from a success", () =>
      Result.succeed("A").pipe(
        Effect.fromResult,
        Effect.tap((_) => Effect.sync(() => assert.strictEqual(_, "A"))),
        Effect.runPromise
      ))

    it("from a failure", () =>
      Result.fail("error").pipe(
        Effect.fromResult,
        Effect.flip,
        Effect.tap((error) => Effect.sync(() => assert.strictEqual(error, "error"))),
        Effect.runPromise
      ))
  })

  describe("gen", () => {
    it("gen", () =>
      Effect.gen(function*() {
        const result = yield* Effect.succeed(1)
        assert.strictEqual(result, 1)
        return result
      }).pipe(Effect.runPromise).then((_) => assert.deepStrictEqual(_, 1)))

    it("gen with context", () =>
      Effect.gen({ self: { a: 1, b: 2 } }, function*() {
        const result = yield* Effect.succeed(this.a)
        assert.strictEqual(result, 1)
        return result + this.b
      }).pipe(Effect.runPromise).then((_) => assert.deepStrictEqual(_, 3)))
  })

  describe("forEach", () => {
    it("sequential", () =>
      Effect.gen(function*() {
        const results = yield* Effect.forEach([1, 2, 3], (_) => Effect.succeed(_))
        assert.deepStrictEqual(results, [1, 2, 3])
      }).pipe(Effect.runPromise))

    it("unbounded", () =>
      Effect.gen(function*() {
        const results = yield* Effect.forEach([1, 2, 3], (_) => Effect.succeed(_), { concurrency: "unbounded" })
        assert.deepStrictEqual(results, [1, 2, 3])
      }).pipe(Effect.runPromise))

    it("bounded", () =>
      Effect.gen(function*() {
        const results = yield* Effect.forEach([1, 2, 3, 4, 5], (_) => Effect.succeed(_), { concurrency: 2 })
        assert.deepStrictEqual(results, [1, 2, 3, 4, 5])
      }).pipe(Effect.runPromise))

    it.effect("inherit unbounded", () =>
      Effect.gen(function*() {
        const handle = yield* Effect.forEach([1, 2, 3], (_) => Effect.succeed(_).pipe(Effect.delay(50)), {
          concurrency: "inherit"
        }).pipe(
          Effect.withConcurrency("unbounded"),
          Effect.forkChild
        )
        yield* TestClock.adjust(90)
        assert.deepStrictEqual(handle.pollUnsafe(), Exit.succeed([1, 2, 3]))
      }))

    it.effect("sequential interrupt", () =>
      Effect.gen(function*() {
        const done: Array<number> = []
        const fiber = yield* Effect.forEach([1, 2, 3, 4, 5, 6], (i) =>
          Effect.sync(() => {
            done.push(i)
            return i
          }).pipe(Effect.delay(300))).pipe(Effect.forkChild)
        yield* TestClock.adjust(800)
        yield* Fiber.interrupt(fiber)
        const result = yield* Fiber.await(fiber)
        assert.isTrue(Exit.hasInterrupts(result))
        assert.deepStrictEqual(done, [1, 2])
      }))

    it.effect("unbounded interrupt", () =>
      Effect.gen(function*() {
        const done: Array<number> = []
        const fiber = yield* Effect.forEach([1, 2, 3], (i) =>
          Effect.sync(() => {
            done.push(i)
            return i
          }).pipe(Effect.delay(150)), { concurrency: "unbounded" }).pipe(Effect.forkChild)
        yield* TestClock.adjust(50)
        yield* Fiber.interrupt(fiber)
        const result = yield* Fiber.await(fiber)
        assert.isTrue(Exit.hasInterrupts(result))
        assert.deepStrictEqual(done, [])
      }))

    it.effect("bounded interrupt", () =>
      Effect.gen(function*() {
        const done: Array<number> = []
        const fiber = yield* Effect.forEach([1, 2, 3, 4, 5, 6], (i) =>
          Effect.sync(() => {
            done.push(i)
            return i
          }).pipe(Effect.delay(200)), { concurrency: 2 }).pipe(Effect.forkChild)
        yield* TestClock.adjust(350)
        yield* Fiber.interrupt(fiber)
        const result = yield* Fiber.await(fiber)
        assert.isTrue(Exit.hasInterrupts(result))
        assert.deepStrictEqual(done, [1, 2])
      }))

    it.effect("unbounded fail", () =>
      Effect.gen(function*() {
        const done: Array<number> = []
        const handle = yield* Effect.forEach([1, 2, 3, 4, 5], (i) =>
          Effect.suspend(() => {
            done.push(i)
            return i === 3 ? Effect.fail("error") : Effect.succeed(i)
          }).pipe(Effect.delay(i * 100)), {
          concurrency: "unbounded"
        }).pipe(Effect.forkChild)
        yield* TestClock.adjust(500)
        const result = yield* Fiber.await(handle)
        assert.deepStrictEqual(result, Exit.fail("error"))
        assert.deepStrictEqual(done, [1, 2, 3])
      }))

    it("length = 0", () =>
      Effect.gen(function*() {
        const results = yield* Effect.forEach([], (_) => Effect.succeed(_))
        assert.deepStrictEqual(results, [])
      }).pipe(Effect.runPromise))

    it("string", () =>
      Effect.gen(function*() {
        const results = yield* Effect.forEach("abc", (_) => Effect.succeed(_))
        assert.deepStrictEqual(results, ["a", "b", "c"])
      }).pipe(Effect.runPromise))
  })

  describe("all", () => {
    it("tuple", () =>
      Effect.gen(function*() {
        const results = (yield* Effect.all([
          Effect.succeed(1),
          Effect.succeed(2),
          Effect.succeed(3)
        ])) satisfies [
          number,
          number,
          number
        ]
        assert.deepStrictEqual(results, [1, 2, 3])
      }).pipe(Effect.runPromise))

    it("record", () =>
      Effect.gen(function*() {
        const results = (yield* Effect.all({
          a: Effect.succeed(1),
          b: Effect.succeed("2"),
          c: Effect.succeed(true)
        })) satisfies {
          a: number
          b: string
          c: boolean
        }
        assert.deepStrictEqual(results, {
          a: 1,
          b: "2",
          c: true
        })
      }).pipe(Effect.runPromise))

    it.effect("record discard", () =>
      Effect.gen(function*() {
        const results = (yield* Effect.all({
          a: Effect.succeed(1),
          b: Effect.succeed("2"),
          c: Effect.succeed(true)
        }, { discard: true })) satisfies void
        assert.deepStrictEqual(results, void 0)
      }))

    it.effect("iterable", () =>
      Effect.gen(function*() {
        const results = (yield* Effect.all(
          new Set([
            Effect.succeed(1),
            Effect.succeed(2),
            Effect.succeed(3)
          ])
        )) satisfies Array<number>
        assert.deepStrictEqual(results, [1, 2, 3])
      }))

    it.effect("tuple result mode", () =>
      Effect.gen(function*() {
        const executed: Array<number> = []
        const results = (yield* Effect.all(
          [
            Effect.sync(() => {
              executed.push(1)
              return 1
            }),
            Effect.sync(() => {
              executed.push(2)
            }).pipe(Effect.andThen(Effect.fail("boom"))),
            Effect.sync(() => {
              executed.push(3)
              return 3
            })
          ] as const,
          { mode: "result" }
        )) satisfies [
          Result.Result<number, never>,
          Result.Result<never, string>,
          Result.Result<number, never>
        ]
        assert.deepStrictEqual(executed, [1, 2, 3])
        assert.deepStrictEqual(results, [
          Result.succeed(1),
          Result.fail("boom"),
          Result.succeed(3)
        ])
      }))

    it.effect("record result mode", () =>
      Effect.gen(function*() {
        const results = (yield* Effect.all({
          a: Effect.succeed(1),
          b: Effect.fail("boom"),
          c: Effect.succeed(true)
        }, { mode: "result" })) satisfies {
          a: Result.Result<number, never>
          b: Result.Result<never, string>
          c: Result.Result<boolean, never>
        }
        assert.deepStrictEqual(results, {
          a: Result.succeed(1),
          b: Result.fail("boom"),
          c: Result.succeed(true)
        })
      }))
  })

  describe("partition", () => {
    it.effect("collects only successes", () =>
      Effect.gen(function*() {
        const values = [0, 1, 2, 3, 4]
        const [excluded, satisfying] = yield* Effect.partition(values, Effect.succeed)
        assert.deepStrictEqual(excluded, [])
        assert.deepStrictEqual(satisfying, values)
      }))

    it.effect("collects only failures", () =>
      Effect.gen(function*() {
        const values = [0, 1, 2, 3, 4]
        const [excluded, satisfying] = yield* Effect.partition(values, Effect.fail)
        assert.deepStrictEqual(excluded, values)
        assert.deepStrictEqual(satisfying, [])
      }))

    it.effect("collects failures and successes", () =>
      Effect.gen(function*() {
        const values = [0, 1, 2, 3, 4, 5]
        const [excluded, satisfying] = yield* Effect.partition(values, (n) =>
          n % 2 === 0 ? Effect.fail(n) : Effect.succeed(n))
        assert.deepStrictEqual(excluded, [0, 2, 4])
        assert.deepStrictEqual(satisfying, [1, 3, 5])
      }))

    it.effect("supports concurrency option", () =>
      Effect.gen(function*() {
        const values = [0, 1, 2, 3, 4, 5]
        const [excluded, satisfying] = yield* Effect.partition(
          values,
          (n) => n % 2 === 0 ? Effect.fail(n) : Effect.succeed(n),
          { concurrency: "unbounded" }
        )
        assert.deepStrictEqual(excluded, [0, 2, 4])
        assert.deepStrictEqual(satisfying, [1, 3, 5])
      }))
  })

  describe("validate", () => {
    it.effect("collects successes when all effects succeed", () =>
      Effect.gen(function*() {
        const values = [0, 1, 2, 3, 4]
        const satisfying = yield* Effect.validate(values, Effect.succeed)
        assert.deepStrictEqual(satisfying, values)
      }))

    it.effect("accumulates all failures", () =>
      Effect.gen(function*() {
        const values = [0, 1, 2, 3, 4, 5]
        const errors = yield* Effect.validate(values, (n) => n % 2 === 0 ? Effect.fail(n) : Effect.succeed(n)).pipe(
          Effect.flip
        )
        assert.deepStrictEqual(errors, [0, 2, 4])
      }))

    it.effect("supports discard option", () =>
      Effect.gen(function*() {
        const result = yield* Effect.validate([1, 2, 3], Effect.succeed, { discard: true })
        assert.strictEqual(result, undefined)
      }))
  })

  describe("findFirst", () => {
    it.effect("returns first matching element", () =>
      Effect.gen(function*() {
        const result = yield* Effect.findFirst([1, 2, 3, 4], (n) => Effect.succeed(n > 2))
        assert.deepStrictEqual(result, Option.some(3))
      }))

    it.effect("returns none when no element matches", () =>
      Effect.gen(function*() {
        const result = yield* Effect.findFirst([1, 2, 3, 4], (n) => Effect.succeed(n > 10))
        assert.deepStrictEqual(result, Option.none())
      }))

    it.effect("short-circuits on first match", () =>
      Effect.gen(function*() {
        const seen: Array<number> = []
        const result = yield* Effect.findFirst([1, 2, 3, 4], (n) =>
          Effect.sync(() => {
            seen.push(n)
            return n > 2
          }))
        assert.deepStrictEqual(result, Option.some(3))
        assert.deepStrictEqual(seen, [1, 2, 3])
      }))
  })

  describe("findFirstFilter", () => {
    it.effect("returns first successful transformed value", () =>
      Effect.gen(function*() {
        const result = yield* Effect.findFirstFilter([1, 2, 3, 4], (n) =>
          Effect.succeed(n % 2 === 0 ? Result.succeed(`n=${n}`) : Result.failVoid))
        assert.deepStrictEqual(result, Option.some("n=2"))
      }))

    it.effect("passes index to filter", () =>
      Effect.gen(function*() {
        const result = yield* Effect.findFirstFilter([10, 11, 12], (n, i) =>
          Effect.succeed(i === 2 ? Result.succeed(`${n}:${i}`) : Result.failVoid))
        assert.deepStrictEqual(result, Option.some("12:2"))
      }))

    it.effect("returns none when filter never succeeds", () =>
      Effect.gen(function*() {
        const result = yield* Effect.findFirstFilter([1, 2, 3], () => Effect.succeed(Result.failVoid))
        assert.deepStrictEqual(result, Option.none())
      }))
  })

  describe("filter", () => {
    it.live("odd numbers", () =>
      Effect.gen(function*() {
        const results = yield* Effect.filter([1, 2, 3, 4, 5], (value) => Effect.succeed(value % 2 === 1))
        assert.deepStrictEqual(results, [1, 3, 5])
      }))

    it.live("iterable", () =>
      Effect.gen(function*() {
        const results = yield* Effect.filter(new Set([1, 2, 3, 4, 5]), (value) => Effect.succeed(value % 2 === 1))
        assert.deepStrictEqual(results, [1, 3, 5])
      }))
  })

  describe("acquireDisposable", () => {
    it.effect("releases disposables", ({ expect }) =>
      Effect.gen(function*() {
        const acquire = Effect.sync((): Disposable => ({ [Symbol.dispose]: release }))
        const release = vi.fn(() => void 0)

        yield* Effect.scoped(Effect.acquireDisposable(acquire))
        expect(release).toHaveBeenCalledTimes(1)
      }))

    it.effect("releases async disposables", ({ expect }) =>
      Effect.gen(function*() {
        const acquire = Effect.sync((): AsyncDisposable => ({ [Symbol.asyncDispose]: release }))
        const release = vi.fn(async () => void 0)

        yield* Effect.scoped(Effect.acquireDisposable(acquire))
        expect(release).toHaveBeenCalledTimes(1)
      }))
  })

  describe("acquireRelease", () => {
    it("releases on interrupt", () =>
      Effect.gen(function*() {
        let release = false
        const fiber = yield* Effect.acquireRelease(
          Effect.delay(Effect.succeed("foo"), 100),
          () =>
            Effect.sync(() => {
              release = true
            })
        ).pipe(
          Effect.scoped,
          Effect.forkChild({ startImmediately: true })
        )
        fiber.interruptUnsafe()
        yield* Fiber.await(fiber)
        assert.strictEqual(release, true)
      }).pipe(Effect.runPromise))

    it.effect("supports release dependencies", () =>
      Effect.gen(function*() {
        let release = false
        const scope = yield* Scope.make()
        yield* Scope.provide(scope)(
          Effect.provideService(
            Effect.acquireRelease(
              Effect.succeed("foo"),
              () =>
                Effect.flatMap(Effect.service(ATag), () =>
                  Effect.sync(() => {
                    release = true
                  }))
            ),
            ATag,
            "A"
          )
        )
        yield* Scope.close(scope, Exit.void)
        assert.strictEqual(release, true)
      }))
  })

  it.effect("raceAll", () =>
    Effect.gen(function*() {
      const interrupted: Array<number> = []
      const fiber = yield* Effect.raceAll([500, 300, 200, 0, 100].map((ms) =>
        (ms === 0 ? Effect.fail("boom") : Effect.succeed(ms)).pipe(
          Effect.delay(ms),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted.push(ms)
            })
          )
        )
      )).pipe(Effect.forkChild)
      yield* TestClock.adjust("500 millis")
      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result, 100)
      assert.deepStrictEqual(interrupted, [500, 300, 200])
    }))

  it.effect("raceAllFirst", () =>
    Effect.gen(function*() {
      const interrupted: Array<number> = []
      const fiber = yield* Effect.raceAllFirst([500, 300, 200, 0, 100].map((ms) =>
        (ms === 0 ? Effect.fail("boom") : Effect.succeed(ms)).pipe(
          Effect.delay(ms),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted.push(ms)
            })
          )
        )
      )).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust("500 millis")
      const result = yield* Fiber.join(fiber)
      assert.deepStrictEqual(result, Exit.fail("boom"))
      // 100 doesn't start because 0 finishes the race first
      assert.deepStrictEqual(interrupted, [500, 300, 200])
    }))

  describe("repeat", () => {
    it.effect("is interruptible", () =>
      Effect.gen(function*() {
        const fiber = yield* Effect.void.pipe(
          Effect.forever,
          Effect.timeoutOption(50),
          Effect.forkChild
        )
        yield* TestClock.adjust(50)
        const result = yield* Fiber.join(fiber)
        assert.deepStrictEqual(result, Option.none())
      }))

    it.effect("repeat/until - repeats until a condition is true", () =>
      Effect.gen(function*() {
        let input = 10
        let output = 0
        const decrement = Effect.sync(() => --input)
        const increment = Effect.sync(() => output++)
        const result = yield* decrement.pipe(
          Effect.tap(increment),
          Effect.repeat({ until: (n) => n === 0 })
        )
        assert.strictEqual(result, 0)
        assert.strictEqual(output, 10)
      }))

    it.effect("repeat/until - repeats until an effectful condition is true", () =>
      Effect.gen(function*() {
        let input = 10
        let output = 0
        const decrement = Effect.sync(() => --input)
        const increment = Effect.sync(() => output++)
        const result = yield* decrement.pipe(
          Effect.tap(increment),
          Effect.repeat({ until: (n) => Effect.succeed(n === 0) })
        )
        assert.strictEqual(result, 0)
        assert.strictEqual(output, 10)
      }))

    it.effect("repeat/until - always evaluates at least once", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.sync(() => n++)
        yield* Effect.repeat(increment, { until: constTrue })
        assert.strictEqual(n, 1)
      }))

    it.effect("repeat/while - repeats while a condition is true", () =>
      Effect.gen(function*() {
        let input = 10
        let output = 0
        const decrement = Effect.sync(() => --input)
        const increment = Effect.sync(() => output++)
        const result = yield* decrement.pipe(
          Effect.tap(increment),
          Effect.repeat({ while: (n) => n > 0 })
        )
        assert.strictEqual(result, 0)
        assert.strictEqual(output, 10)
      }))

    it.effect("repeat/while - repeats while an effectful condition is true", () =>
      Effect.gen(function*() {
        let input = 10
        let output = 0
        const decrement = Effect.sync(() => --input)
        const increment = Effect.sync(() => output++)
        const result = yield* decrement.pipe(
          Effect.tap(increment),
          Effect.repeat({ while: (n) => Effect.succeed(n > 0) })
        )
        assert.strictEqual(result, 0)
        assert.strictEqual(output, 10)
      }))

    it.effect("repeat/while - always evaluates at least once", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.sync(() => n++)
        yield* Effect.repeat(increment, { while: constFalse })
        assert.strictEqual(n, 1)
      }))

    it.effect("repeat/times", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.sync(() => ++n)
        const result = yield* Effect.repeat(increment, {
          times: 2
        })
        assert.strictEqual(n, 3)
        assert.strictEqual(result, 3)
      }))

    it.effect("repeat/schedule - repeats according to the specified schedule", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.sync(() => ++n)
        const result = yield* Effect.repeat(increment, Schedule.recurs(3))
        assert.strictEqual(result, 3)
      }))

    it.effect("repeat/schedule - with until", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.sync(() => ++n)
        const result = yield* Effect.repeat(increment, {
          schedule: Schedule.recurs(3),
          until: (n) => n === 3
        })
        assert.strictEqual(n, 3)
        assert.strictEqual(result, 3)
      }))

    it.effect("repeat/schedule - with while", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.sync(() => ++n)
        const result = yield* Effect.repeat(increment, {
          schedule: Schedule.recurs(3),
          while: (n) => n < 3
        })
        assert.strictEqual(n, 3)
        assert.strictEqual(result, 3) // schedule result
      }))
  })

  describe("retry", () => {
    it.live("nothing on success", () =>
      Effect.gen(function*() {
        let count = 0
        yield* Effect.sync(() => count++).pipe(
          Effect.retry({ times: 10000 })
        )
        assert.strictEqual(count, 1)
      }))

    it.effect("retry/until - retries until a condition is true", () =>
      Effect.gen(function*() {
        let input = 10
        let output = 0
        const decrement = Effect.sync(() => --input)
        const increment = Effect.sync(() => output++)
        const result = yield* decrement.pipe(
          Effect.tap(increment),
          Effect.flip,
          Effect.retry({ until: (n) => n === 0 }),
          Effect.flip
        )
        assert.strictEqual(result, 0)
        assert.strictEqual(output, 10)
      }))

    it.effect("retry/until - retries until an effectful condition is true", () =>
      Effect.gen(function*() {
        let input = 10
        let output = 0
        const decrement = Effect.sync(() => --input)
        const increment = Effect.sync(() => output++)
        const result = yield* decrement.pipe(
          Effect.tap(increment),
          Effect.flip,
          Effect.retry({ until: (n) => Effect.succeed(n === 0) }),
          Effect.flip
        )
        assert.strictEqual(result, 0)
        assert.strictEqual(output, 10)
      }))

    it.effect("retry/until - always evaluates at least once", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.failSync(() => n++)
        yield* increment.pipe(
          Effect.retry({ until: constTrue }),
          Effect.flip
        )
        assert.strictEqual(n, 1)
      }))

    it.effect("retry/while - retries while a condition is true", () =>
      Effect.gen(function*() {
        let input = 10
        let output = 0
        const decrement = Effect.sync(() => --input)
        const increment = Effect.sync(() => output++)
        const result = yield* decrement.pipe(
          Effect.tap(increment),
          Effect.flip,
          Effect.retry({ while: (n) => n > 0 }),
          Effect.flip
        )
        assert.strictEqual(result, 0)
        assert.strictEqual(output, 10)
      }))

    it.effect("retry/while - retries while an effectful condition is true", () =>
      Effect.gen(function*() {
        let input = 10
        let output = 0
        const decrement = Effect.sync(() => --input)
        const increment = Effect.sync(() => output++)
        const result = yield* decrement.pipe(
          Effect.tap(increment),
          Effect.flip,
          Effect.retry({ while: (n) => Effect.succeed(n > 0) }),
          Effect.flip
        )
        assert.strictEqual(result, 0)
        assert.strictEqual(output, 10)
      }))

    it.effect("retry/while - always evaluates at least once", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.failSync(() => n++)
        yield* increment.pipe(
          Effect.retry({ while: constFalse }),
          Effect.flip
        )
        assert.strictEqual(n, 1)
      }))

    it.effect("retry/schedule - retries according to the specified schedule", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.failSync(() => n++)
        yield* increment.pipe(
          Effect.retry(Schedule.recurs(3)),
          Effect.flip
        )
        assert.strictEqual(n, 4)
      }))

    it.effect("retry/schedule - with until", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.failSync(() => ++n)
        yield* increment.pipe(
          Effect.retry({
            schedule: Schedule.recurs(3),
            until: (n) => n === 3
          }),
          Effect.flip
        )
        assert.strictEqual(n, 3)
      }))

    it.effect("retry/schedule - until errors", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.failSync(() => ++n)
        const result = yield* increment.pipe(
          Effect.retry({
            schedule: Schedule.recurs(3),
            until: () => Effect.fail("boom")
          }),
          Effect.flip
        )
        assert.strictEqual(n, 1)
        assert.strictEqual(result, "boom")
      }))

    it.effect("retry/schedule - with while", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.failSync(() => ++n)
        yield* increment.pipe(
          Effect.retry({
            schedule: Schedule.recurs(3),
            while: (n) => n < 3
          }),
          Effect.flip
        )
        assert.strictEqual(n, 3)
      }))

    it.effect("retry/schedule - while errors", () =>
      Effect.gen(function*() {
        let n = 0
        const increment = Effect.failSync(() => ++n)
        const result = yield* increment.pipe(
          Effect.retry({
            schedule: Schedule.recurs(3),
            while: () => Effect.fail("boom")
          }),
          Effect.flip
        )
        assert.strictEqual(n, 1)
        assert.strictEqual(result, "boom")
      }))

    it.effect("retry/schedule - CurrentMetadata", () =>
      Effect.gen(function*() {
        const metadata: Array<Schedule.Metadata> = []
        yield* pipe(
          Effect.gen(function*() {
            const meta = yield* Schedule.CurrentMetadata
            metadata.push(meta)
          }),
          Effect.flip,
          Effect.retry(Schedule.recurs(3)),
          Effect.flip
        )
        assert.deepStrictEqual(metadata, [
          {
            elapsed: 0,
            elapsedSincePrevious: 0,
            attempt: 0,
            input: undefined,
            output: undefined,
            now: 0,
            start: 0,
            duration: Duration.zero
          },
          {
            elapsed: 0,
            elapsedSincePrevious: 0,
            attempt: 1,
            input: undefined,
            output: 0,
            now: 0,
            start: 0,
            duration: Duration.zero
          },
          {
            elapsed: 0,
            elapsedSincePrevious: 0,
            attempt: 2,
            input: undefined,
            output: 1,
            now: 0,
            start: 0,
            duration: Duration.zero
          },
          {
            elapsed: 0,
            elapsedSincePrevious: 0,
            attempt: 3,
            input: undefined,
            output: 2,
            now: 0,
            start: 0,
            duration: Duration.zero
          }
        ])
      }))
  })

  describe("timeoutOption", () => {
    it.live("timeout a long computation", () =>
      Effect.gen(function*() {
        const result = yield* pipe(
          Effect.sleep(60_000),
          Effect.andThen(Effect.succeed(true)),
          Effect.timeoutOption(10)
        )
        assert.deepStrictEqual(result, Option.none())
      }))
    it.live("timeout a long computation with a failure", () =>
      Effect.gen(function*() {
        const error = new Error("boom")
        const result = yield* pipe(
          Effect.sleep(5000),
          Effect.andThen(Effect.succeed(true)),
          Effect.timeoutOrElse({
            orElse: () => Effect.die(error),
            duration: 10
          }),
          Effect.sandbox,
          Effect.flip
        )
        assert.deepStrictEqual(result, Cause.die(error))
      }))
    it.effect("timeout repetition of uninterruptible effect", () =>
      Effect.gen(function*() {
        const fiber = yield* pipe(
          Effect.void,
          Effect.uninterruptible,
          Effect.forever,
          Effect.timeoutOption(10),
          Effect.forkChild
        )
        yield* TestClock.adjust(10)
        const result = yield* Fiber.join(fiber)
        assert.deepStrictEqual(result, Option.none())
      }))
    it.effect("timeout in uninterruptible region", () =>
      Effect.void.pipe(
        Effect.timeoutOption(20_000),
        Effect.uninterruptible
      ), { timeout: 1000 })
  })

  describe("timeout", () => {
    it.live("timeout a long computation", () =>
      Effect.gen(function*() {
        const result = yield* pipe(
          Effect.sleep(60_000),
          Effect.andThen(Effect.succeed(true)),
          Effect.timeout(10),
          Effect.flip
        )
        assert.deepStrictEqual(result, new Cause.TimeoutError())
      }))
  })

  describe("interruption", () => {
    it.effect("sync forever is interruptible", () =>
      Effect.gen(function*() {
        const fiber = yield* pipe(Effect.succeed(1), Effect.forever, Effect.forkChild)
        yield* Fiber.interrupt(fiber)
        assert(Exit.hasInterrupts(fiber.pollUnsafe()!))
      }))

    it.effect("interrupt of never is interrupted with cause", () =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.never)
        yield* Fiber.interrupt(fiber)
        assert(Exit.hasInterrupts(fiber.pollUnsafe()!))
      }))

    it.effect("catch + ensuring + interrupt", () =>
      Effect.gen(function*() {
        let catchFailure = false
        let ensuring = false
        const handle = yield* Effect.never.pipe(
          Effect.catchCause((_) =>
            Effect.sync(() => {
              catchFailure = true
            })
          ),
          Effect.ensuring(Effect.sync(() => {
            ensuring = true
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Fiber.interrupt(handle)
        assert.isFalse(catchFailure)
        assert.isTrue(ensuring)
      }))

    it.effect("run of interruptible", () =>
      Effect.gen(function*() {
        let recovered = false
        const fiber = yield* Effect.never.pipe(
          Effect.interruptible,
          Effect.exit,
          Effect.flatMap((result) =>
            Effect.sync(() => {
              recovered = result._tag === "Failure" && Cause.hasInterruptsOnly(result.cause)
            })
          ),
          Effect.uninterruptible,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Fiber.interrupt(fiber)
        assert.isTrue(recovered)
      }))

    it.effect("alternating interruptibility", () =>
      Effect.gen(function*() {
        let counter = 0
        const fiber = yield* Effect.never.pipe(
          Effect.interruptible,
          Effect.exit,
          Effect.andThen(Effect.sync(() => {
            counter++
          })),
          Effect.uninterruptible,
          Effect.interruptible,
          Effect.exit,
          Effect.andThen(Effect.sync(() => {
            counter++
          })),
          Effect.uninterruptible,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Fiber.interrupt(fiber)
        assert.strictEqual(counter, 2)
      }))

    it.live("acquireUseRelease use inherits interrupt status", () =>
      Effect.gen(function*() {
        let ref = false
        const fiber = yield* Effect.acquireUseRelease(
          Effect.succeed(123),
          (_) =>
            Effect.sync(() => {
              ref = true
            }).pipe(
              Effect.delay(10)
            ),
          () => Effect.void
        ).pipe(
          Effect.uninterruptible,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Fiber.interrupt(fiber)
        assert.isTrue(ref)
      }))

    it.live("async can be uninterruptible", () =>
      Effect.gen(function*() {
        let ref = false
        const fiber = yield* Effect.sleep(10).pipe(
          Effect.andThen(Effect.sync(() => {
            ref = true
          })),
          Effect.uninterruptible,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Fiber.interrupt(fiber)
        assert.isTrue(ref)
      }))

    it.live("callback cannot resume on interrupt", () =>
      Effect.gen(function*() {
        const fiber = yield* Effect.callback<string>((resume) => {
          setTimeout(() => {
            resume(Effect.succeed("foo"))
          }, 10)
        }).pipe(
          Effect.onInterrupt(() => Effect.sleep(30)),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Fiber.interrupt(fiber)
        assert.isTrue(Exit.hasInterrupts(fiber.pollUnsafe()!))
      }))

    it.live("closing scope is uninterruptible", () =>
      Effect.gen(function*() {
        let ref = false
        const child = pipe(
          Effect.sleep(10),
          Effect.andThen(Effect.sync(() => {
            ref = true
          }))
        )
        const fiber = yield* child.pipe(Effect.uninterruptible, Effect.forkChild({ startImmediately: true }))
        yield* Fiber.interrupt(fiber)
        assert.isTrue(ref)
      }))

    it.effect("AbortSignal is aborted", () =>
      Effect.gen(function*() {
        let signal: AbortSignal
        const fiber = yield* Effect.callback<void>((_cb, signal_) => {
          signal = signal_
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Fiber.interrupt(fiber)
        assert.strictEqual(signal!.aborted, true)
      }))
  })

  describe("awaitAllChildren", () => {
    it.effect("awaits children forked by the wrapped effect", () =>
      Effect.gen(function*() {
        const latch = yield* Deferred.make<void>()
        const fiber = yield* Effect.gen(function*() {
          yield* Deferred.await(latch).pipe(Effect.forkChild)
          return 1
        }).pipe(
          Effect.awaitAllChildren,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        assert.strictEqual(fiber.pollUnsafe(), undefined)
        yield* Deferred.succeed(latch, void 0)
        const result = yield* Fiber.join(fiber)
        assert.strictEqual(result, 1)
      }))

    it.effect("does not await children forked outside the wrapped effect", () =>
      Effect.gen(function*() {
        const preexisting = yield* Effect.never.pipe(Effect.forkChild({ startImmediately: true }))
        const fiber = yield* Effect.succeed(1).pipe(
          Effect.awaitAllChildren,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        assert.deepStrictEqual(fiber.pollUnsafe(), Exit.succeed(1))
        yield* Fiber.interrupt(preexisting)
      }))

    it.effect("does not await preexisting children in the same fiber", () =>
      Effect.gen(function*() {
        const preexistingLatch = yield* Deferred.make<void>()
        const scopedLatch = yield* Deferred.make<void>()
        const fiber = yield* Effect.gen(function*() {
          yield* Deferred.await(preexistingLatch).pipe(Effect.forkChild)
          return yield* Effect.gen(function*() {
            yield* Deferred.await(scopedLatch).pipe(Effect.forkChild)
            return 1
          }).pipe(Effect.awaitAllChildren)
        }).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        assert.strictEqual(fiber.pollUnsafe(), undefined)
        yield* Deferred.succeed(scopedLatch, void 0)
        yield* Effect.yieldNow
        assert.deepStrictEqual(fiber.pollUnsafe(), Exit.succeed(1))
      }))
  })

  describe("fork", () => {
    it.effect("is interrupted with parent", () =>
      Effect.gen(function*() {
        let child = false
        let parent = false
        const fiber = yield* Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              child = true
            })
          ),
          Effect.forkChild({ startImmediately: true }),
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              parent = true
            })
          ),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Fiber.interrupt(fiber)
        assert.isTrue(child)
        assert.isTrue(parent)
      }))
  })

  describe("forkDaemon", () => {
    it.effect("is not interrupted with parent", () =>
      Effect.gen(function*() {
        let child = false
        let parent = false
        const handle = yield* Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              child = true
            })
          ),
          Effect.forkDetach,
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              parent = true
            })
          ),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Fiber.interrupt(handle)
        assert.isFalse(child)
        assert.isTrue(parent)
      }))
  })

  describe("forkIn", () => {
    it.effect("is interrupted when scope is closed", () =>
      Effect.gen(function*() {
        let interrupted = false
        const scope = yield* Scope.make()
        yield* Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
            })
          ),
          Effect.forkIn(scope, { startImmediately: true })
        )
        yield* Scope.close(scope, Exit.void)
        assert.isTrue(interrupted)
      }))
  })

  describe("forkScoped", () => {
    it.effect("is interrupted when scope is closed", () =>
      Effect.gen(function*() {
        let interrupted = false
        const scope = yield* Scope.make()
        yield* Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
            })
          ),
          Effect.forkScoped({ startImmediately: true }),
          Scope.provide(scope)
        )
        yield* Scope.close(scope, Exit.void)
        assert.isTrue(interrupted)
      }))
  })

  describe("do notation", () => {
    it.effect("works", () =>
      Effect.succeed(1).pipe(
        Effect.bindTo("a"),
        Effect.let("b", ({ a }) => a + 1),
        Effect.bind("b", ({ b }) => Effect.succeed(b.toString())),
        Effect.tap((value) =>
          Effect.sync(() => {
            assert.deepStrictEqual(value, {
              a: 1,
              b: "2"
            })
          })
        )
      ))
  })

  describe("stack safety", () => {
    it.live("recursion", () => {
      const loop: Effect.Effect<void> = Effect.void.pipe(
        Effect.flatMap((_) => loop)
      )
      return loop.pipe(
        Effect.timeoutOption(50)
      )
    })
  })

  describe("finalization", () => {
    const ExampleError = new Error("Oh noes!")

    it.effect("fail ensuring", () =>
      Effect.gen(function*() {
        let finalized = false
        const result = yield* Effect.fail(ExampleError).pipe(
          Effect.ensuring(Effect.sync(() => {
            finalized = true
          })),
          Effect.exit
        )
        assert.deepStrictEqual(result, Exit.fail(ExampleError))
        assert.isTrue(finalized)
      }))

    it.effect("fail on error", () =>
      Effect.gen(function*() {
        let finalized = false
        const result = yield* Effect.fail(ExampleError).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              finalized = true
            })
          ),
          Effect.exit
        )
        assert.deepStrictEqual(result, Exit.fail(ExampleError))
        assert.isTrue(finalized)
      }))

    it.effect("finalizer errors not caught", () =>
      Effect.gen(function*() {
        const e2 = new Error("e2")
        const e3 = new Error("e3")
        const result = yield* pipe(
          Effect.fail(ExampleError),
          Effect.ensuring(Effect.die(e2)),
          Effect.ensuring(Effect.die(e3)),
          Effect.sandbox,
          Effect.flip,
          Effect.map((cause) => cause)
        )
        assert.deepStrictEqual(result, Cause.die(e3))
      }))

    it.effect("finalizer errors reported", () =>
      Effect.gen(function*() {
        let reported: Exit.Exit<number> | undefined
        const result = yield* pipe(
          Effect.succeed(42),
          Effect.ensuring(Effect.die(ExampleError)),
          Effect.forkChild,
          Effect.flatMap((fiber) =>
            pipe(
              Fiber.await(fiber),
              Effect.flatMap((e) =>
                Effect.sync(() => {
                  reported = e
                })
              )
            )
          )
        )
        assert.isUndefined(result)
        assert.isFalse(reported !== undefined && Exit.isSuccess(reported))
      }))

    it.effect("acquireUseRelease usage result", () =>
      Effect.gen(function*() {
        const result = yield* Effect.acquireUseRelease(
          Effect.void,
          () => Effect.succeed(42),
          () => Effect.void
        )
        assert.strictEqual(result, 42)
      }))

    it.effect("error in just acquisition", () =>
      Effect.gen(function*() {
        const result = yield* pipe(
          Effect.acquireUseRelease(
            Effect.fail(ExampleError),
            () => Effect.void,
            () => Effect.void
          ),
          Effect.exit
        )
        assert.deepStrictEqual(result, Exit.fail(ExampleError))
      }))

    it.effect("error in just release", () =>
      Effect.gen(function*() {
        const result = yield* pipe(
          Effect.acquireUseRelease(
            Effect.void,
            () => Effect.void,
            () => Effect.die(ExampleError)
          ),
          Effect.exit
        )
        assert.deepStrictEqual(result, Exit.die(ExampleError))
      }))

    it.effect("error in just usage", () =>
      Effect.gen(function*() {
        const result = yield* pipe(
          Effect.acquireUseRelease(
            Effect.void,
            () => Effect.fail(ExampleError),
            () => Effect.void
          ),
          Effect.exit
        )
        assert.deepStrictEqual(result, Exit.fail(ExampleError))
      }))

    it.effect("rethrown caught error in acquisition", () =>
      Effect.gen(function*() {
        const result = yield* Effect.acquireUseRelease(
          Effect.fail(ExampleError),
          () => Effect.void,
          () => Effect.void
        ).pipe(Effect.flip)
        assert.deepEqual(result, ExampleError)
      }))

    it.effect("rethrown caught error in release", () =>
      Effect.gen(function*() {
        const result = yield* pipe(
          Effect.acquireUseRelease(
            Effect.void,
            () => Effect.void,
            () => Effect.die(ExampleError)
          ),
          Effect.exit
        )
        assert.deepStrictEqual(result, Exit.die(ExampleError))
      }))

    it.effect("rethrown caught error in usage", () =>
      Effect.gen(function*() {
        const result = yield* Effect.acquireUseRelease(
          Effect.void,
          () => Effect.fail(ExampleError),
          () => Effect.void
        ).pipe(Effect.exit)
        assert.deepEqual(result, Exit.fail(ExampleError))
      }))

    it.effect("onResult - ensures that a cleanup function runs when an effect fails", () =>
      Effect.gen(function*() {
        let ref = false
        yield* Effect.die("boom").pipe(
          Effect.onExit((result) =>
            Exit.hasDies(result) ?
              Effect.sync(() => {
                ref = true
              }) :
              Effect.void
          ),
          Effect.sandbox,
          Effect.ignore
        )
        assert.isTrue(ref)
      }))
  })

  describe("Effect.ignore", () => {
    type IgnoreOptions = { readonly log?: boolean | LogLevel.Severity; readonly message?: string }

    const makeTestLogger = () => {
      const capturedLogs: Array<{
        readonly logLevel: LogLevel.LogLevel
        readonly cause: Cause.Cause<unknown>
        readonly message: unknown
      }> = []
      const testLogger = Logger.make<unknown, void>((options) => {
        capturedLogs.push({ logLevel: options.logLevel, cause: options.cause, message: options.message })
      })
      return { capturedLogs, testLogger }
    }

    const runIgnore = (options?: IgnoreOptions, currentLogLevel: LogLevel.Severity = "Info") =>
      Effect.gen(function*() {
        const { capturedLogs, testLogger } = makeTestLogger()
        const program = options === undefined
          ? Effect.fail("boom").pipe(Effect.ignore)
          : Effect.fail("boom").pipe(Effect.ignore(options))
        yield* program.pipe(
          Effect.provide(Logger.layer([testLogger])),
          Effect.provideService(References.MinimumLogLevel, "Trace"),
          Effect.provideService(References.CurrentLogLevel, currentLogLevel)
        )
        return capturedLogs
      })

    it.effect("does not log when log is omitted", () =>
      Effect.gen(function*() {
        const logs = yield* runIgnore()
        assert.strictEqual(logs.length, 0)
      }))

    it.effect("does not log when log is false", () =>
      Effect.gen(function*() {
        const logs = yield* runIgnore({ log: false })
        assert.strictEqual(logs.length, 0)
      }))

    it.effect("logs with the current level when log is true", () =>
      Effect.gen(function*() {
        const logs = yield* runIgnore({ log: true }, "Warn")
        assert.strictEqual(logs.length, 1)
        assert.strictEqual(logs[0].logLevel, "Warn")
        assertCauseFail(logs[0].cause, "boom")
      }))

    it.effect("logs with the provided level when log is a LogLevel", () =>
      Effect.gen(function*() {
        const logs = yield* runIgnore({ log: "Error" }, "Warn")
        assert.strictEqual(logs.length, 1)
        assert.strictEqual(logs[0].logLevel, "Error")
        assertCauseFail(logs[0].cause, "boom")
      }))

    it.effect("prepends the provided message when logging", () =>
      Effect.gen(function*() {
        const logs = yield* runIgnore({ log: true, message: "Ignoring failure" })
        assert.strictEqual(logs.length, 1)
        assert.deepStrictEqual(logs[0].message, ["Ignoring failure"])
        assertCauseFail(logs[0].cause, "boom")
      }))
  })

  describe("Effect.ignoreCause", () => {
    type IgnoreCauseOptions = { readonly log?: boolean | LogLevel.Severity; readonly message?: string }

    const makeTestLogger = () => {
      const capturedLogs: Array<{
        readonly logLevel: LogLevel.LogLevel
        readonly cause: Cause.Cause<unknown>
        readonly message: unknown
      }> = []
      const testLogger = Logger.make<unknown, void>((options) => {
        capturedLogs.push({ logLevel: options.logLevel, cause: options.cause, message: options.message })
      })
      return { capturedLogs, testLogger }
    }

    const runIgnoreCause = (options?: IgnoreCauseOptions, currentLogLevel: LogLevel.Severity = "Info") =>
      Effect.gen(function*() {
        const { capturedLogs, testLogger } = makeTestLogger()
        const program = options === undefined
          ? Effect.fail("boom").pipe(Effect.ignoreCause)
          : Effect.fail("boom").pipe(Effect.ignoreCause(options))
        yield* program.pipe(
          Effect.provide(Logger.layer([testLogger])),
          Effect.provideService(References.MinimumLogLevel, "Trace"),
          Effect.provideService(References.CurrentLogLevel, currentLogLevel)
        )
        return capturedLogs
      })

    it.effect("ignores defects", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.die("boom").pipe(Effect.ignoreCause, Effect.exit)
        assert.deepStrictEqual(exit, Exit.void)
      }))

    it.effect("ignores interrupts", () =>
      Effect.gen(function*() {
        const ignored = yield* Effect.interrupt.pipe(Effect.ignoreCause, Effect.exit)
        assert.deepStrictEqual(ignored, Exit.void)
      }))

    it.effect("does not log when log is omitted", () =>
      Effect.gen(function*() {
        const logs = yield* runIgnoreCause()
        assert.strictEqual(logs.length, 0)
      }))

    it.effect("does not log when log is false", () =>
      Effect.gen(function*() {
        const logs = yield* runIgnoreCause({ log: false })
        assert.strictEqual(logs.length, 0)
      }))

    it.effect("logs with the current level when log is true", () =>
      Effect.gen(function*() {
        const logs = yield* runIgnoreCause({ log: true }, "Warn")
        assert.strictEqual(logs.length, 1)
        assert.strictEqual(logs[0].logLevel, "Warn")
        assertCauseFail(logs[0].cause, "boom")
      }))

    it.effect("logs with the provided level when log is a LogLevel", () =>
      Effect.gen(function*() {
        const logs = yield* runIgnoreCause({ log: "Error" }, "Warn")
        assert.strictEqual(logs.length, 1)
        assert.strictEqual(logs[0].logLevel, "Error")
        assertCauseFail(logs[0].cause, "boom")
      }))

    it.effect("prepends the provided message when logging", () =>
      Effect.gen(function*() {
        const logs = yield* runIgnoreCause({ log: true, message: "Ignoring cause" })
        assert.strictEqual(logs.length, 1)
        assert.deepStrictEqual(logs[0].message, ["Ignoring cause"])
        assertCauseFail(logs[0].cause, "boom")
      }))
  })

  describe("error handling", () => {
    class ErrorA extends Data.TaggedError("A") {}
    class ErrorB extends Data.TaggedError("B") {}
    class ErrorC extends Data.Error {}

    it.effect("catchTag", () =>
      Effect.gen(function*() {
        let error: ErrorA | ErrorB | ErrorC = new ErrorA()
        const effect = Effect.failSync(() => error).pipe(
          Effect.catchTag("A", (_) => Effect.succeed(1)),
          Effect.catchTag("B", (_) => Effect.succeed(2)),
          Effect.orElseSucceed(() => 3)
        )
        assert.strictEqual(yield* effect, 1)
        error = new ErrorB()
        assert.strictEqual(yield* effect, 2)
        error = new ErrorC()
        assert.strictEqual(yield* effect, 3)
      }))

    it.effect("catchTag orElse", () =>
      Effect.gen(function*() {
        let error: ErrorA | ErrorB | ErrorC = new ErrorA()
        const effect = Effect.failSync(() => error).pipe(
          Effect.catchTag(["A", "B"], (_) => Effect.succeed(1), (_) => {
            return Effect.succeed(2)
          })
        )
        assert.strictEqual(yield* effect, 1)
        error = new ErrorB()
        assert.strictEqual(yield* effect, 1)
        error = new ErrorC()
        assert.strictEqual(yield* effect, 2)
      }))

    it.effect("catchTags orElse", () =>
      Effect.gen(function*() {
        let error: ErrorA | ErrorB | ErrorC = new ErrorA()
        const effect = Effect.failSync(() => error).pipe(
          Effect.catchTags(
            {
              A: (_) => Effect.succeed(1),
              B: (_) => Effect.succeed(2)
            },
            (_) => Effect.succeed(3)
          )
        )
        assert.strictEqual(yield* effect, 1)
        error = new ErrorB()
        assert.strictEqual(yield* effect, 2)
        error = new ErrorC()
        assert.strictEqual(yield* effect, 3)
      }))

    it.effect("tapErrorTag", () =>
      Effect.gen(function*() {
        let error: ErrorA | ErrorB | ErrorC = new ErrorA()
        const tapped: Array<string> = []
        const effect = Effect.failSync(() => error).pipe(
          Effect.tapErrorTag("A", () =>
            Effect.sync(() => {
              tapped.push("A")
            })),
          Effect.tapErrorTag("B", () =>
            Effect.sync(() => {
              tapped.push("B")
            })),
          Effect.exit
        )
        assert.deepStrictEqual(yield* effect, Exit.fail(error))
        assert.deepStrictEqual(tapped, ["A"])

        tapped.length = 0
        error = new ErrorB()
        assert.deepStrictEqual(yield* effect, Exit.fail(error))
        assert.deepStrictEqual(tapped, ["B"])

        tapped.length = 0
        error = new ErrorC()
        assert.deepStrictEqual(yield* effect, Exit.fail(error))
        assert.deepStrictEqual(tapped, [])
      }))

    it.effect("catchIf with refinement", () =>
      Effect.gen(function*() {
        interface ErrorA {
          readonly _tag: "ErrorA"
        }
        interface ErrorB {
          readonly _tag: "ErrorB"
        }
        const effect: Effect.Effect<never, ErrorA | ErrorB> = Effect.fail({ _tag: "ErrorB" as const })
        const result = yield* pipe(
          effect,
          Effect.catchIf((e): e is ErrorA => e._tag === "ErrorA", Effect.succeed),
          Effect.exit
        )
        assert.deepStrictEqual(result, Exit.fail({ _tag: "ErrorB" as const }))
      }))

    it.effect("catchIf with refinement orElse", () =>
      Effect.gen(function*() {
        interface ErrorA {
          readonly _tag: "ErrorA"
        }
        interface ErrorB {
          readonly _tag: "ErrorB"
        }
        const effect: Effect.Effect<never, ErrorA | ErrorB> = Effect.fail({ _tag: "ErrorB" as const })
        const result = yield* pipe(
          effect,
          Effect.catchIf((e): e is ErrorA => e._tag === "ErrorA", Effect.succeed, (_) => {
            return Effect.succeed(1)
          })
        )
        assert.deepStrictEqual(result, 1)
      }))

    it.effect("catchNoSuchElement", () =>
      Effect.gen(function*() {
        const some = yield* Effect.fromNullishOr("value").pipe(Effect.catchNoSuchElement)
        assert.deepStrictEqual(some, Option.some("value"))

        const none = yield* Effect.fromNullishOr(null as string | null).pipe(Effect.catchNoSuchElement)
        assert.deepStrictEqual(none, Option.none())
      }))

    it.effect("catchNoSuchElement preserves other errors", () =>
      Effect.gen(function*() {
        const error = new ErrorA()
        const result = yield* Effect.fail(error).pipe(Effect.catchNoSuchElement, Effect.exit)
        assert.deepStrictEqual(result, Exit.fail(error))
      }))
  })

  describe("zip", () => {
    it.effect("concurrent: false", () => {
      const executionOrder: Array<string> = []
      const task1 = Effect.succeed("a").pipe(
        Effect.delay(50),
        Effect.tap(() => Effect.sync(() => executionOrder.push("task1")))
      )
      const task2 = Effect.succeed(1).pipe(
        Effect.delay(1),
        Effect.tap(() => Effect.sync(() => executionOrder.push("task2")))
      )
      return Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.zip(task1, task2))
        yield* TestClock.adjust(51)
        const result = yield* Fiber.join(fiber)
        assert.deepStrictEqual(result, ["a", 1])
        assert.deepStrictEqual(executionOrder, ["task1", "task2"])
      })
    })
    it.effect("concurrent: true", () => {
      const executionOrder: Array<string> = []
      const task1 = Effect.succeed("a").pipe(
        Effect.delay(50),
        Effect.tap(() => Effect.sync(() => executionOrder.push("task1")))
      )
      const task2 = Effect.succeed(1).pipe(
        Effect.delay(1),
        Effect.tap(() => Effect.sync(() => executionOrder.push("task2")))
      )
      return Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.zip(task1, task2, { concurrent: true }))
        yield* TestClock.adjust(50)
        const result = yield* Fiber.join(fiber)
        assert.deepStrictEqual(result, ["a", 1])
        assert.deepStrictEqual(executionOrder, ["task2", "task1"])
      })
    })
  })

  describe("zipWith", () => {
    it.effect("concurrent: false", () => {
      const executionOrder: Array<string> = []
      const task1 = Effect.succeed("a").pipe(
        Effect.delay(50),
        Effect.tap(() => Effect.sync(() => executionOrder.push("task1")))
      )
      const task2 = Effect.succeed(1).pipe(
        Effect.delay(1),
        Effect.tap(() => Effect.sync(() => executionOrder.push("task2")))
      )
      return Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.zipWith(task1, task2, (a, b) => a + b))
        yield* TestClock.adjust(51)
        const result = yield* Fiber.join(fiber)
        assert.deepStrictEqual(result, "a1")
        assert.deepStrictEqual(executionOrder, ["task1", "task2"])
      })
    })
    it.effect("concurrent: true", () => {
      const executionOrder: Array<string> = []
      const task1 = Effect.succeed("a").pipe(
        Effect.delay(50),
        Effect.tap(() => Effect.sync(() => executionOrder.push("task1")))
      )
      const task2 = Effect.succeed(1).pipe(
        Effect.delay(1),
        Effect.tap(() => Effect.sync(() => executionOrder.push("task2")))
      )
      return Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.zipWith(task1, task2, (a, b) => a + b, { concurrent: true }))
        yield* TestClock.adjust(50)
        const result = yield* Fiber.join(fiber)
        assert.deepStrictEqual(result, "a1")
        assert.deepStrictEqual(executionOrder, ["task2", "task1"])
      })
    })
  })

  describe("catchCauseFilter", () => {
    it.effect("first argument as success", () =>
      Effect.gen(function*() {
        const result = yield* Effect.catchCauseFilter(Effect.succeed(1), (_) => Result.fail(_), () => Effect.fail("e2"))
        assert.deepStrictEqual(result, 1)
      }))
    it.effect("first argument as failure and predicate return false", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(
          Effect.catchCauseFilter(Effect.fail("e1" as const), (_) => Result.fail(_), () => Effect.fail("e2" as const))
        )
        assert.deepStrictEqual(result, "e1")
      }))
    it.effect("first argument as failure and predicate return true", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(
          Effect.catchCauseFilter(
            Effect.fail("e1" as const),
            (e) => Result.succeed(e),
            () => Effect.fail("e2" as const)
          )
        )
        assert.deepStrictEqual(result, "e2")
      }))
  })

  describe("catchIf with predicate", () => {
    it.effect("predicate match recovers", () =>
      Effect.gen(function*() {
        const result = yield* Effect.catchIf(
          Effect.fail("e1"),
          (e) => typeof e === "string",
          (e) => Effect.succeed(`recovered: ${e}`)
        )
        assert.deepStrictEqual(result, "recovered: e1")
      }))
    it.effect("predicate no match preserves error", () =>
      Effect.gen(function*() {
        const result = yield* Effect.exit(
          Effect.catchIf(
            Effect.fail("e1" as const),
            (_e) => false,
            () => Effect.succeed("recovered")
          )
        )
        assert.deepStrictEqual(result, Exit.fail("e1"))
      }))
  })

  describe("catchCauseIf with predicate", () => {
    it.effect("predicate match recovers", () =>
      Effect.gen(function*() {
        const result = yield* Effect.catchCauseIf(
          Effect.fail("e1"),
          Cause.hasFails,
          (cause) => Effect.succeed(`recovered: ${Cause.squash(cause)}`)
        )
        assert.deepStrictEqual(result, "recovered: e1")
      }))
    it.effect("predicate no match preserves error", () =>
      Effect.gen(function*() {
        const result = yield* Effect.exit(
          Effect.catchCauseIf(
            Effect.fail("e1" as const),
            constFalse,
            () => Effect.succeed("recovered")
          )
        )
        assert.deepStrictEqual(result, Exit.fail("e1"))
      }))
  })

  describe("tapCauseIf", () => {
    it.effect("filter match taps", () =>
      Effect.gen(function*() {
        const tapped: Array<string> = []
        const result = yield* Effect.exit(
          Effect.tapCauseFilter(
            Effect.fail("e1"),
            (cause) => Result.succeed(cause),
            (cause) => Effect.sync(() => tapped.push(Cause.squash(cause) as string))
          )
        )
        assert.deepStrictEqual(tapped, ["e1"])
        assert.deepStrictEqual(result, Exit.fail("e1"))
      }))
    it.effect("filter no match skips tap", () =>
      Effect.gen(function*() {
        const tapped: Array<string> = []
        const result = yield* Effect.exit(
          Effect.tapCauseFilter(
            Effect.fail("e1"),
            (cause) => Result.fail(cause),
            () => Effect.sync(() => tapped.push("tapped"))
          )
        )
        assert.deepStrictEqual(tapped, [])
        assert.deepStrictEqual(result, Exit.fail("e1"))
      }))
    it.effect("predicate match taps", () =>
      Effect.gen(function*() {
        const tapped: Array<string> = []
        const result = yield* Effect.exit(
          Effect.tapCauseIf(
            Effect.fail("e1"),
            Cause.hasFails,
            (cause) => Effect.sync(() => tapped.push(Cause.squash(cause) as string))
          )
        )
        assert.deepStrictEqual(tapped, ["e1"])
        assert.deepStrictEqual(result, Exit.fail("e1"))
      }))
    it.effect("predicate no match skips tap", () =>
      Effect.gen(function*() {
        const tapped: Array<string> = []
        const result = yield* Effect.exit(
          Effect.tapCauseIf(
            Effect.fail("e1"),
            constFalse,
            () => Effect.sync(() => tapped.push("tapped"))
          )
        )
        assert.deepStrictEqual(tapped, [])
        assert.deepStrictEqual(result, Exit.fail("e1"))
      }))
    it.effect("success skips tap", () =>
      Effect.gen(function*() {
        const tapped: Array<string> = []
        const result = yield* Effect.tapCauseIf(
          Effect.succeed(42),
          constTrue,
          () => Effect.sync(() => tapped.push("tapped"))
        )
        assert.deepStrictEqual(tapped, [])
        assert.deepStrictEqual(result, 42)
      }))
  })

  describe("onErrorIf", () => {
    it.effect("predicate match runs finalizer", () =>
      Effect.gen(function*() {
        const finalized: Array<string> = []
        const result = yield* Effect.exit(
          Effect.onErrorIf(
            Effect.fail("e1"),
            Cause.hasFails,
            (cause) => Effect.sync(() => finalized.push(Cause.squash(cause) as string))
          )
        )
        assert.deepStrictEqual(finalized, ["e1"])
        assert.deepStrictEqual(result, Exit.fail("e1"))
      }))
    it.effect("predicate no match skips finalizer", () =>
      Effect.gen(function*() {
        const finalized: Array<string> = []
        const result = yield* Effect.exit(
          Effect.onErrorIf(
            Effect.fail("e1"),
            constFalse,
            () => Effect.sync(() => finalized.push("finalized"))
          )
        )
        assert.deepStrictEqual(finalized, [])
        assert.deepStrictEqual(result, Exit.fail("e1"))
      }))
    it.effect("filter match runs finalizer", () =>
      Effect.gen(function*() {
        const finalized: Array<string> = []
        const result = yield* Effect.exit(
          Effect.onErrorFilter(
            Effect.fail("e1"),
            Cause.findError as Filter.Filter<Cause.Cause<string>, string>,
            (error: string) => Effect.sync(() => finalized.push(error))
          )
        )
        assert.deepStrictEqual(finalized, ["e1"])
        assert.deepStrictEqual(result, Exit.fail("e1"))
      }))
    it.effect("success skips finalizer", () =>
      Effect.gen(function*() {
        const finalized: Array<string> = []
        const result = yield* Effect.onErrorIf(
          Effect.succeed(42),
          constTrue,
          () => Effect.sync(() => finalized.push("finalized"))
        )
        assert.deepStrictEqual(finalized, [])
        assert.deepStrictEqual(result, 42)
      }))
  })

  describe("onExitIf", () => {
    it.effect("predicate match on success runs finalizer", () =>
      Effect.gen(function*() {
        const finalized: Array<string> = []
        const result = yield* Effect.onExitIf(
          Effect.succeed(42),
          Exit.isSuccess,
          (exit) => {
            if (Exit.isSuccess(exit)) {
              return Effect.sync(() => finalized.push(`success:${exit.value}`))
            }
            return Effect.void
          }
        )
        assert.deepStrictEqual(finalized, ["success:42"])
        assert.deepStrictEqual(result, 42)
      }))
    it.effect("predicate no match on failure skips finalizer", () =>
      Effect.gen(function*() {
        const finalized: Array<string> = []
        const result = yield* Effect.exit(
          Effect.onExitIf(
            Effect.fail("e1"),
            Exit.isSuccess,
            () => Effect.sync(() => finalized.push("finalized"))
          )
        )
        assert.deepStrictEqual(finalized, [])
        assert.deepStrictEqual(result, Exit.fail("e1"))
      }))
    it.effect("predicate match on failure runs finalizer", () =>
      Effect.gen(function*() {
        const finalized: Array<string> = []
        const result = yield* Effect.exit(
          Effect.onExitIf(
            Effect.fail("e1"),
            Exit.isFailure,
            (exit) => {
              if (Exit.isFailure(exit)) {
                return Effect.sync(() => finalized.push(`failure:${Cause.squash(exit.cause)}`))
              }
              return Effect.void
            }
          )
        )
        assert.deepStrictEqual(finalized, ["failure:e1"])
        assert.deepStrictEqual(result, Exit.fail("e1"))
      }))
    it.effect("filter match receives pass value and exit", () =>
      Effect.gen(function*() {
        const finalized: Array<string> = []
        const result = yield* Effect.onExitFilter(
          Effect.succeed(42),
          (exit) => Exit.isSuccess(exit) ? Result.succeed(`value:${exit.value}`) : Result.fail(exit),
          (value, exit) =>
            Effect.sync(() => finalized.push(`${value}:${Exit.isSuccess(exit) ? `success:${exit.value}` : "failure"}`))
        )
        assert.deepStrictEqual(finalized, ["value:42:success:42"])
        assert.deepStrictEqual(result, 42)
      }))
  })

  describe("filter with predicate/refinement", () => {
    it.effect("predicate filters iterable", () =>
      Effect.gen(function*() {
        const result = yield* Effect.filter(
          [1, 2, 3, 4, 5],
          (n: number) => n % 2 === 0
        )
        assert.deepStrictEqual(result, [2, 4])
      }))
    it.effect("refinement narrows iterable", () =>
      Effect.gen(function*() {
        const result = yield* Effect.filter(
          [1, "a", 2, "b", 3] as Array<number | string>,
          (x): x is number => typeof x === "number"
        )
        assert.deepStrictEqual(result, [1, 2, 3])
      }))
    it.effect("Filter.Filter overload maps pass values", () =>
      Effect.gen(function*() {
        const filter: Filter.Filter<number, string, number> = (n) =>
          n % 2 === 0 ? Result.succeed(`n=${n}`) : Result.fail(n)
        const result = yield* Effect.filterMap(
          [1, 2, 3, 4],
          filter
        )
        assert.deepStrictEqual(result, ["n=2", "n=4"])
      }))
  })

  describe("catch", () => {
    it.effect("first argument as success", () =>
      Effect.gen(function*() {
        const result = yield* Effect.catch(Effect.succeed(1), () => Effect.fail("e2" as const))
        assert.deepStrictEqual(result, 1)
      }))
    it.effect("first argument as failure", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(Effect.catch(Effect.fail("e1" as const), () => Effect.fail("e2" as const)))
        assert.deepStrictEqual(result, "e2")
      }))
  })

  describe("firstSuccessOf", () => {
    it.effect("returns the first success and does not run later effects", () =>
      Effect.gen(function*() {
        const executed: Array<string> = []
        const result = yield* Effect.firstSuccessOf([
          Effect.sync(() => executed.push("first")).pipe(
            Effect.flatMap(() => Effect.fail("e1" as const))
          ),
          Effect.sync(() => executed.push("second")).pipe(
            Effect.as("success" as const)
          ),
          Effect.sync(() => executed.push("third")).pipe(
            Effect.as("unreachable" as const)
          )
        ])

        assert.strictEqual(result, "success")
        assert.deepStrictEqual(executed, ["first", "second"])
      }))

    it.effect("fails with the last failure when all effects fail", () =>
      Effect.gen(function*() {
        const result = yield* Effect.firstSuccessOf([
          Effect.fail("e1" as const),
          Effect.fail("e2" as const),
          Effect.fail("e3" as const)
        ]).pipe(Effect.flip)

        assert.strictEqual(result, "e3")
      }))

    it.effect("defects on an empty collection", () =>
      Effect.gen(function*() {
        const result = yield* Effect.firstSuccessOf([]).pipe(Effect.sandbox, Effect.flip)
        const reason = result.reasons[0]

        assert.isTrue(Cause.isDieReason(reason))
        if (Cause.isDieReason(reason)) {
          assert.instanceOf(reason.defect, Error)
          assert.strictEqual(reason.defect.message, "Received an empty collection of effects")
        }
      }))
  })

  describe("catchCause", () => {
    it.effect("first argument as success", () =>
      Effect.gen(function*() {
        const result = yield* Effect.catchCause(Effect.succeed(1), () => Effect.fail("e2" as const))
        assert.deepStrictEqual(result, 1)
      }))
    it.effect("first argument as failure", () =>
      Effect.gen(function*() {
        const result = yield* Effect.flip(
          Effect.catchCause(Effect.fail("e1" as const), () => Effect.fail("e2" as const))
        )
        assert.deepStrictEqual(result, "e2")
      }))
  })

  describe("transaction (composable transactions)", () => {
    describe("basic behavior", () => {
      it.effect("should create transaction boundaries when no transaction is active", () =>
        Effect.gen(function*() {
          const ref1 = TxRef.makeUnsafe(0)
          const ref2 = TxRef.makeUnsafe(100)

          yield* Effect.tx(TxRef.set(ref1, 10))

          yield* Effect.tx(TxRef.set(ref2, 200))

          const val1 = yield* Effect.tx(TxRef.get(ref1))
          const val2 = yield* Effect.tx(TxRef.get(ref2))

          assert.strictEqual(val1, 10)
          assert.strictEqual(val2, 200)
        }))

      it.effect("should allow TxRef.modify outside an existing transaction", () =>
        Effect.gen(function*() {
          const ref = TxRef.makeUnsafe(0)

          const result = yield* TxRef.modify(ref, (current) => [current + 1, current + 10])
          const value = yield* Effect.tx(TxRef.get(ref))

          assert.strictEqual(result, 1)
          assert.strictEqual(value, 10)
        }))

      it.effect("should roll back nested changes when the outer transaction fails", () =>
        Effect.gen(function*() {
          const ref1 = TxRef.makeUnsafe(0)
          const ref2 = TxRef.makeUnsafe(100)

          const parentError = yield* Effect.tx(Effect.gen(function*() {
            yield* TxRef.set(ref1, 10)

            yield* Effect.tx(TxRef.set(ref2, 200))

            return yield* Effect.fail("parent failed")
          })).pipe(Effect.flip)

          const val1 = yield* Effect.tx(TxRef.get(ref1))
          const val2 = yield* Effect.tx(TxRef.get(ref2))

          assert.strictEqual(parentError, "parent failed")
          assert.strictEqual(val1, 0)
          assert.strictEqual(val2, 100)
        }))

      it.effect("should allow catching nested failures in the same transaction", () =>
        Effect.gen(function*() {
          const ref1 = TxRef.makeUnsafe(0)
          const ref2 = TxRef.makeUnsafe(100)

          yield* Effect.tx(Effect.gen(function*() {
            yield* TxRef.set(ref1, 10)

            const childResult = yield* Effect.tx(Effect.gen(function*() {
              yield* TxRef.set(ref2, 200)
              return yield* Effect.fail("child failed")
            })).pipe(Effect.result)

            yield* TxRef.set(ref1, 20)

            assert.strictEqual(Result.isFailure(childResult), true)
          }))

          const val1 = yield* Effect.tx(TxRef.get(ref1))
          const val2 = yield* Effect.tx(TxRef.get(ref2))

          assert.strictEqual(val1, 20)
          assert.strictEqual(val2, 200)
        }))
    })

    describe("transaction nesting", () => {
      it.effect("should handle multiple levels of nested composed transactions", () =>
        Effect.gen(function*() {
          const ref1 = TxRef.makeUnsafe(0)
          const ref2 = TxRef.makeUnsafe(0)
          const ref3 = TxRef.makeUnsafe(0)

          yield* Effect.tx(Effect.gen(function*() {
            yield* TxRef.set(ref1, 1)

            yield* Effect.tx(Effect.gen(function*() {
              yield* TxRef.set(ref2, 2)

              yield* Effect.tx(TxRef.set(ref3, 3))
            }))
          }))

          const val1 = yield* Effect.tx(TxRef.get(ref1))
          const val2 = yield* Effect.tx(TxRef.get(ref2))
          const val3 = yield* Effect.tx(TxRef.get(ref3))

          assert.strictEqual(val1, 1)
          assert.strictEqual(val2, 2)
          assert.strictEqual(val3, 3)
        }))
    })

    describe("transaction composition behavior", () => {
      it.effect("should compose nested tx calls into the same transaction", () =>
        Effect.gen(function*() {
          const ref1 = TxRef.makeUnsafe(0)
          const ref2 = TxRef.makeUnsafe(0)

          yield* Effect.tx(Effect.gen(function*() {
            yield* TxRef.set(ref1, 10)

            yield* Effect.tx(TxRef.set(ref2, 20))
          }))

          const val1 = yield* Effect.tx(TxRef.get(ref1))
          const val2 = yield* Effect.tx(TxRef.get(ref2))

          assert.strictEqual(val1, 10)
          assert.strictEqual(val2, 20)
        }))

      it.effect("should rollback the entire composed transaction on failure", () =>
        Effect.gen(function*() {
          const ref = TxRef.makeUnsafe(0)

          const txError = yield* Effect.tx(Effect.gen(function*() {
            yield* TxRef.set(ref, 10)

            return yield* Effect.tx(Effect.gen(function*() {
              yield* TxRef.set(ref, 20)
              return yield* Effect.fail("nested failure")
            }))
          })).pipe(Effect.flip)

          const valueAfterFailure = yield* Effect.tx(TxRef.get(ref))

          assert.strictEqual(txError, "nested failure")
          assert.strictEqual(valueAfterFailure, 0)
        }))

      it.effect("should preserve nested writes when nested failure is caught", () =>
        Effect.gen(function*() {
          const ref = TxRef.makeUnsafe(0)

          yield* Effect.tx(Effect.gen(function*() {
            yield* TxRef.set(ref, 10)

            const childError = yield* Effect.tx(Effect.gen(function*() {
              yield* TxRef.set(ref, 20)
              return yield* Effect.fail("transaction nested failure")
            })).pipe(Effect.flip)

            assert.strictEqual(childError, "transaction nested failure")
          }))

          const transactionValue = yield* Effect.tx(TxRef.get(ref))

          assert.strictEqual(transactionValue, 20)
        }))
    })
  })

  describe("Effect.fn", () => {
    it.effect("should support pipeable arguments", () => {
      const fn = Effect.fn(function*(s: string) {
        return s.length
      }, (effect, ...args) => effect.pipe(Effect.map((result) => [result, ...args])))
      return Effect.gen(function*() {
        const result = yield* fn("a")
        assert.deepStrictEqual(result, [1, "a"])
      })
    })

    it("should proxy body length", () => {
      const traced = Effect.fn(function*(a: string, b: number) {
        return a.length + b
      })
      const named = Effect.fn("named")(function*(a: string, b: number, c: boolean) {
        return c ? a.length + b : b
      })
      const untraced = Effect.fnUntraced(function*(a: string, b: number) {
        return a.length + b
      }, Effect.map((n) => n))

      assert.strictEqual(traced.length, 2)
      assert.strictEqual(named.length, 3)
      assert.strictEqual(untraced.length, 2)
    })
  })

  describe("catchReason", () => {
    class RateLimitError extends Data.TaggedError("RateLimitError")<{
      readonly retryAfter: number
    }> {}

    class QuotaExceededError extends Data.TaggedError("QuotaExceededError")<{
      readonly limit: number
    }> {}

    class AiError extends Data.TaggedError("AiError")<{
      readonly reason: RateLimitError | QuotaExceededError
    }> {}

    class OtherError extends Data.TaggedError("OtherError")<{
      readonly message: string
    }> {}

    it.effect("catches matching reason - handler succeeds", () =>
      Effect.gen(function*() {
        const result = yield* Effect.fail(
          new AiError({ reason: new RateLimitError({ retryAfter: 60 }) })
        ).pipe(
          Effect.catchReason("AiError", "RateLimitError", (r) => Effect.succeed(`retry: ${r.retryAfter}`))
        )
        assert.strictEqual(result, "retry: 60")
      }))

    it.effect("orElse", () =>
      Effect.gen(function*() {
        const result = yield* Effect.fail(
          new AiError({ reason: new QuotaExceededError({ limit: 100 }) })
        ).pipe(
          Effect.catchReason(
            "AiError",
            "RateLimitError",
            (r) => Effect.succeed(`retry: ${r.retryAfter}`),
            (_) => Effect.succeed("quota")
          )
        )
        assert.strictEqual(result, "quota")
      }))

    it.effect("catches matching reason - handler fails", () =>
      Effect.gen(function*() {
        const reason = new RateLimitError({ retryAfter: 60 })
        const error = new OtherError({ message: "handled" })
        const exit = yield* Effect.fail(new AiError({ reason })).pipe(
          Effect.catchReason("AiError", "RateLimitError", () => Effect.fail(error)),
          Effect.exit
        )
        assertExitFailure(exit, Cause.fail(error))
      }))

    it.effect("ignores non-matching reason", () =>
      Effect.gen(function*() {
        const reason = new QuotaExceededError({ limit: 100 })
        const exit = yield* Effect.fail(new AiError({ reason })).pipe(
          Effect.catchReason("AiError", "RateLimitError", () => Effect.succeed("no")),
          Effect.exit
        )
        assertExitFailure(exit, Cause.fail(new AiError({ reason })))
      }))

    it.effect("ignores non-matching parent tag", () =>
      Effect.gen(function*() {
        const error = new OtherError({ message: "test" })
        const exit = yield* (Effect.fail(error) as Effect.Effect<never, AiError | OtherError>).pipe(
          Effect.catchReason("AiError", "RateLimitError", () => Effect.succeed("no")),
          Effect.exit
        )
        assertExitFailure(exit, Cause.fail(error))
      }))
  })

  describe("catchReasons", () => {
    class RateLimitError extends Data.TaggedError("RateLimitError")<{
      readonly retryAfter: number
    }> {}

    class QuotaExceededError extends Data.TaggedError("QuotaExceededError")<{
      readonly limit: number
    }> {}

    class AiError extends Data.TaggedError("AiError")<{
      readonly reason: RateLimitError | QuotaExceededError
    }> {}

    it.effect("catches with object handlers", () =>
      Effect.gen(function*() {
        const result = yield* Effect.fail(
          new AiError({ reason: new RateLimitError({ retryAfter: 60 }) })
        ).pipe(
          Effect.catchReasons("AiError", {
            RateLimitError: (r) => Effect.succeed(`rate: ${r.retryAfter}`),
            QuotaExceededError: (r) => Effect.succeed(`quota: ${r.limit}`)
          })
        )
        assert.strictEqual(result, "rate: 60")
      }))

    it.effect("orElse", () =>
      Effect.gen(function*() {
        const result = yield* Effect.fail(
          new AiError({ reason: new RateLimitError({ retryAfter: 60 }) })
        ).pipe(
          Effect.catchReasons("AiError", {
            QuotaExceededError: (r) => Effect.succeed(`quota: ${r.limit}`)
          }, (_) => Effect.succeed("orElse"))
        )
        assert.strictEqual(result, "orElse")
      }))

    it.effect("catches second reason type", () =>
      Effect.gen(function*() {
        const result = yield* Effect.fail(
          new AiError({ reason: new QuotaExceededError({ limit: 100 }) })
        ).pipe(
          Effect.catchReasons("AiError", {
            RateLimitError: (r) => Effect.succeed(`rate: ${r.retryAfter}`),
            QuotaExceededError: (r) => Effect.succeed(`quota: ${r.limit}`)
          })
        )
        assert.strictEqual(result, "quota: 100")
      }))

    it.effect("partial handlers - unhandled passes through", () =>
      Effect.gen(function*() {
        const reason = new QuotaExceededError({ limit: 100 })
        const exit = yield* Effect.fail(new AiError({ reason })).pipe(
          Effect.catchReasons("AiError", {
            RateLimitError: () => Effect.succeed("handled")
          }),
          Effect.exit
        )
        assertExitFailure(exit, Cause.fail(new AiError({ reason })))
      }))
  })

  describe("unwrapReason", () => {
    class RateLimitError extends Data.TaggedError("RateLimitError")<{
      readonly retryAfter: number
    }> {}

    class QuotaExceededError extends Data.TaggedError("QuotaExceededError")<{
      readonly limit: number
    }> {}

    class AiError extends Data.TaggedError("AiError")<{
      readonly reason: RateLimitError | QuotaExceededError
    }> {}

    class OtherError extends Data.TaggedError("OtherError")<{
      readonly message: string
    }> {}

    it.effect("extracts reason into error channel", () =>
      Effect.gen(function*() {
        const reason = new RateLimitError({ retryAfter: 60 })
        const exit = yield* Effect.fail(new AiError({ reason })).pipe(
          Effect.unwrapReason("AiError"),
          Effect.exit
        )
        assertExitFailure(exit, Cause.fail(reason))
      }))

    it.effect("extracts second reason type", () =>
      Effect.gen(function*() {
        const reason = new QuotaExceededError({ limit: 100 })
        const exit = yield* Effect.fail(new AiError({ reason })).pipe(
          Effect.unwrapReason("AiError"),
          Effect.exit
        )
        assertExitFailure(exit, Cause.fail(reason))
      }))

    it.effect("preserves other errors", () =>
      Effect.gen(function*() {
        const error = new OtherError({ message: "test" })
        const exit = yield* (Effect.fail(error) as Effect.Effect<never, AiError | OtherError>).pipe(
          Effect.unwrapReason("AiError"),
          Effect.exit
        )
        assertExitFailure(exit, Cause.fail(error))
      }))
  })

  describe("cachedWithTTL", () => {
    it.effect("starts ttl from value creation", () =>
      Effect.gen(function*() {
        let count = 0
        const cached = yield* Effect.cachedWithTTL(
          Effect.sleep("2 seconds").pipe(
            Effect.flatMap(() =>
              Effect.sync(() => {
                count += 1
                return count
              })
            )
          ),
          "1 second"
        )

        const firstFiber = yield* Effect.forkChild(cached)
        yield* Effect.yieldNow
        yield* TestClock.adjust("2 seconds")
        assert.strictEqual(yield* Fiber.join(firstFiber), 1)

        const secondFiber = yield* Effect.forkChild(cached)
        yield* Effect.yieldNow
        yield* TestClock.adjust("2 seconds")
        assert.strictEqual(yield* Fiber.join(secondFiber), 1)
        assert.strictEqual(count, 1)
      }))
  })

  describe("provide", () => {
    class MyNumber extends Context.Service<MyNumber, number>()("MyNumber") {}

    it.effect("subsequent calls share MemoMap", () =>
      Effect.gen(function*() {
        let buildCount = 0
        const layer = Layer.sync(MyNumber, () => {
          buildCount += 1
          return 42
        })

        // @effect-diagnostics multipleEffectProvide:off
        yield* Effect.void.pipe(
          Effect.provide(layer, { local: true }), // local always builds the layer
          Effect.provide(layer),
          Effect.provide(layer)
        )

        assert.strictEqual(buildCount, 2)
      }))
  })
})
