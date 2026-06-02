import { describe, expect, it } from "@effect/vitest"
import { Array, Duration, Effect, Fiber, Pull, Random, Schedule } from "effect"
import { constant, constUndefined } from "effect/Function"
import { TestClock } from "effect/testing"

describe("Schedule", () => {
  describe("collecting", () => {
    it.effect("collectInputs - should collect all schedule inputs", () =>
      Effect.gen(function*() {
        const schedule = Schedule.collectInputs(Schedule.forever)
        const inputs = Array.range(1, 5)
        const outputs = yield* runLast(schedule, inputs)
        expect(outputs).toEqual(inputs)
      }))

    it.effect("collectOutputs - should collect all schedule outputs", () =>
      Effect.gen(function*() {
        const schedule = Schedule.collectOutputs(Schedule.forever)
        const inputs = Array.makeBy(5, constUndefined)
        const outputs = yield* runLast(schedule, inputs)
        expect(outputs).toEqual([0, 1, 2, 3, 4])
      }))

    it.effect("collectWhile - should collect while the predicate holds", () =>
      Effect.gen(function*() {
        const schedule = Schedule.collectWhile(Schedule.forever, ({ output }) => Effect.succeed(output < 3))
        const inputs = Array.makeBy(5, constUndefined)
        const outputs = yield* runLast(schedule, inputs)
        expect(outputs).toEqual([0, 1, 2, 3])
      }))

    it.effect("collectWhile - should collect while the effectful predicate holds", () =>
      Effect.gen(function*() {
        const schedule = Schedule.collectWhile(Schedule.forever, ({ output }) => Effect.succeed(output < 3))
        const inputs = Array.makeBy(5, constUndefined)
        const outputs = yield* runLast(schedule, inputs)
        expect(outputs).toEqual([0, 1, 2, 3])
      }))
  })

  describe("sequencing", () => {
    it.effect("tap - provides full metadata", () =>
      Effect.gen(function*() {
        const observed: Array<Schedule.Metadata<number, string>> = []
        const schedule = Schedule.spaced(Duration.millis(250)).pipe(
          Schedule.tap((metadata: Schedule.Metadata<number, string>) =>
            Effect.sync(() => {
              observed.push(metadata)
            })
          )
        )
        const step = yield* Schedule.toStep(schedule)
        const first = yield* step(1_000, "a")
        const second = yield* step(1_250, "b")

        expect(first).toEqual([0, Duration.millis(250)])
        expect(second).toEqual([1, Duration.millis(250)])
        expect(observed).toEqual([
          {
            input: "a",
            output: 0,
            duration: Duration.millis(250),
            attempt: 1,
            start: 1_000,
            now: 1_000,
            elapsed: 0,
            elapsedSincePrevious: 0
          },
          {
            input: "b",
            output: 1,
            duration: Duration.millis(250),
            attempt: 2,
            start: 1_000,
            now: 1_250,
            elapsed: 250,
            elapsedSincePrevious: 250
          }
        ])
      }))

    it.effect("andThenResult - executes schedules sequentially to completion", () =>
      Effect.gen(function*() {
        const left = Schedule.fixed("500 millis").pipe(
          Schedule.while(({ attempt }) => Effect.succeed(attempt <= 3))
        )
        const right = Schedule.fixed("1 second")
        const schedule = Schedule.andThenResult(left, right)
        const inputs = Array.makeBy(6, constUndefined)
        const outputs = yield* runDelays(schedule, inputs)
        expect(outputs).toEqual([
          Duration.millis(500),
          Duration.millis(500),
          Duration.millis(500),
          Duration.seconds(1),
          Duration.seconds(1),
          Duration.seconds(1)
        ])
      }))

    it.effect("andThenResult - emits right completion when right schedule is finite", () =>
      Effect.gen(function*() {
        const left = Schedule.fixed("500 millis").pipe(
          Schedule.while(({ attempt }) => Effect.succeed(attempt <= 2))
        )
        const right = Schedule.duration("1 second")
        const schedule = Schedule.andThenResult(left, right)
        const inputs = Array.makeBy(5, constUndefined)
        const outputs = yield* runDelays(schedule, inputs)
        expect(outputs).toEqual([
          Duration.millis(500),
          Duration.millis(500),
          Duration.seconds(1),
          Duration.zero
        ])
      }))
  })

  describe("cron", () => {
    it.effect("should recur on interval matching cron expression", () =>
      Effect.gen(function*() {
        const now = new Date(2024, 0, 1, 0, 0, 35).getTime()
        // At every second minute
        const schedule = Schedule.cron("*/2 * * * *")
        const inputs = Array.makeBy(4, constUndefined)
        yield* TestClock.setTime(now)
        const [, outputs] = yield* runDelays(schedule, inputs).pipe(
          Effect.map(Array.mapAccum(now, (next, delay) => {
            const timestamp = next + Duration.toMillis(delay)
            return [timestamp, format(timestamp)]
          }))
        )
        expect(outputs).toEqual([
          "Mon Jan 01 2024 00:02:00",
          "Mon Jan 01 2024 00:04:00",
          "Mon Jan 01 2024 00:06:00",
          "Mon Jan 01 2024 00:08:00"
        ])
      }))

    it.effect("should recur on interval matching cron expression (second granularity)", () =>
      Effect.gen(function*() {
        const now = new Date(2024, 0, 1, 0, 0, 0).getTime()
        // At every third minute
        const schedule = Schedule.cron("*/3 * * * * *")
        const inputs = Array.makeBy(10, constUndefined)
        yield* TestClock.setTime(now)
        const [, outputs] = yield* runDelays(schedule, inputs).pipe(
          Effect.map(Array.mapAccum(now, (next, delay) => {
            const timestamp = next + Duration.toMillis(delay)
            return [timestamp, format(timestamp)]
          }))
        )
        expect(outputs).toEqual([
          "Mon Jan 01 2024 00:00:03",
          "Mon Jan 01 2024 00:00:06",
          "Mon Jan 01 2024 00:00:09",
          "Mon Jan 01 2024 00:00:12",
          "Mon Jan 01 2024 00:00:15",
          "Mon Jan 01 2024 00:00:18",
          "Mon Jan 01 2024 00:00:21",
          "Mon Jan 01 2024 00:00:24",
          "Mon Jan 01 2024 00:00:27",
          "Mon Jan 01 2024 00:00:30"
        ])
      }))

    it.effect("should recur at time matching cron expression", () =>
      Effect.gen(function*() {
        const now = new Date(2024, 0, 1, 0, 0, 0).getTime()
        // At 04:30 on day-of-month 5 and 15 and on Wednesday.
        const schedule = Schedule.cron("30 4 5,15 * WED")
        const inputs = Array.makeBy(6, constUndefined)
        yield* TestClock.setTime(now)
        const [, outputs] = yield* runDelays(schedule, inputs).pipe(
          Effect.map(Array.mapAccum(now, (next, delay) => {
            const timestamp = next + Duration.toMillis(delay)
            return [timestamp, format(timestamp)]
          }))
        )
        expect(outputs).toEqual([
          "Wed Jan 03 2024 04:30:00",
          "Fri Jan 05 2024 04:30:00",
          "Wed Jan 10 2024 04:30:00",
          "Mon Jan 15 2024 04:30:00",
          "Wed Jan 17 2024 04:30:00",
          "Wed Jan 24 2024 04:30:00"
        ])
      }))
  })

  describe("duration", () => {
    it.effect("recurs once after the provided duration", () =>
      Effect.gen(function*() {
        const schedule = Schedule.duration(Duration.seconds(1))
        const inputs = Array.makeBy(5, constUndefined)
        const output = yield* runDelays(schedule, inputs)
        expect(output).toEqual([Duration.seconds(1), Duration.zero])
      }))
  })

  describe("reduce", () => {
    it.effect("accumulates state with synchronous combine", () =>
      Effect.gen(function*() {
        const schedule = Schedule.forever.pipe(
          Schedule.reduce(() => 0, (state, output) => state + output)
        )
        const inputs = Array.makeBy(5, constUndefined)
        const output = yield* runCollect(schedule, inputs)
        expect(output).toEqual([0, 1, 3, 6, 10])
      }))
  })

  describe("jittered", () => {
    it.effect("keeps delays within 80%-120% of the original", () =>
      Effect.gen(function*() {
        const schedule = Schedule.jittered(Schedule.spaced(Duration.seconds(1)))
        const inputs = Array.makeBy(20, constUndefined)
        const output = yield* runDelays(schedule, inputs).pipe(Random.withSeed("jittered-bounds"))
        expect(output.every((delay) => {
          const millis = Duration.toMillis(delay)
          return millis >= 800 && millis <= 1200
        })).toBe(true)
      }))

    it.effect("does not change completion output", () =>
      Effect.gen(function*() {
        const schedule = Schedule.jittered(Schedule.duration(Duration.seconds(1)))
        const inputs = Array.makeBy(5, constUndefined)
        const output = yield* runDelays(schedule, inputs).pipe(Random.withSeed("jittered-completion"))
        expect(output.length).toEqual(2)
        expect(Duration.toMillis(output[0])).toBeGreaterThanOrEqual(800)
        expect(Duration.toMillis(output[0])).toBeLessThanOrEqual(1200)
        expect(output[1]).toEqual(Duration.zero)
      }))
  })

  describe("spaced", () => {
    it.effect("constant delays", () =>
      Effect.gen(function*() {
        const schedule = Schedule.spaced(Duration.seconds(1))
        const inputs = Array.makeBy(5, constUndefined)
        const output = yield* runDelays(schedule, inputs)
        expect(output).toEqual(Array.makeBy(5, constant(Duration.seconds(1))))
      }))
  })

  describe("fixed", () => {
    it.effect("constant delays", () =>
      Effect.gen(function*() {
        const schedule = Schedule.fixed(Duration.seconds(1))
        const inputs = Array.makeBy(5, constUndefined)
        const output = yield* runDelays(schedule, inputs)
        expect(output).toEqual(Array.makeBy(5, constant(Duration.seconds(1))))
      }))

    it.effect("delays until the nearest window boundary when action is slow", () =>
      Effect.gen(function*() {
        const delays: Array<Duration.Duration> = []
        const schedule = Schedule.fixed("1 seconds").pipe(
          Schedule.while(({ attempt }) => Effect.succeed(attempt <= 5)),
          Schedule.delays,
          Schedule.map((delay) =>
            Effect.sync(() => {
              delays.push(delay)
              return delays
            })
          )
        )
        yield* Effect.sleep("500 millis").pipe(
          Effect.schedule(schedule),
          Effect.forkChild
        )
        yield* TestClock.setTime(Number.POSITIVE_INFINITY)
        expect(delays).toEqual([
          Duration.millis(1000),
          Duration.millis(500),
          Duration.millis(500),
          Duration.millis(500),
          Duration.millis(500),
          Duration.zero
        ])
      }))

    it.effect("matches effect v3 when action duration exceeds the interval", () =>
      Effect.gen(function*() {
        const delays: Array<Duration.Duration> = []
        const schedule = Schedule.fixed("1 seconds").pipe(
          Schedule.while(({ attempt }) => Effect.succeed(attempt <= 5)),
          Schedule.delays,
          Schedule.map((delay) =>
            Effect.sync(() => {
              delays.push(delay)
              return delays
            })
          )
        )
        yield* Effect.sleep("1.5 seconds").pipe(
          Effect.schedule(schedule),
          Effect.forkChild
        )
        yield* TestClock.setTime(Number.POSITIVE_INFINITY)
        expect(delays).toEqual([
          Duration.millis(1000),
          Duration.zero,
          Duration.zero,
          Duration.zero,
          Duration.zero,
          Duration.zero
        ])
      }))
  })

  describe("windowed", () => {
    it.effect("constant delays", () =>
      Effect.gen(function*() {
        const schedule = Schedule.windowed(Duration.seconds(1))
        const inputs = Array.makeBy(5, constUndefined)
        const output = yield* runDelays(schedule, inputs)
        expect(output).toEqual(Array.makeBy(5, constant(Duration.seconds(1))))
      }))

    it.effect("delays until the nearest window boundary", () =>
      Effect.gen(function*() {
        const delays: Array<Duration.Duration> = []
        const schedule = Schedule.windowed("1 seconds").pipe(
          Schedule.while(({ attempt }) => Effect.succeed(attempt <= 5)),
          Schedule.delays,
          Schedule.map((delay) =>
            Effect.sync(() => {
              delays.push(delay)
              return delays
            })
          )
        )
        yield* Effect.sleep("1.5 seconds").pipe(
          Effect.schedule(schedule),
          Effect.forkChild
        )
        yield* TestClock.setTime(Number.POSITIVE_INFINITY)
        expect(delays).toEqual([
          Duration.millis(1000),
          Duration.millis(500),
          Duration.millis(500),
          Duration.millis(500),
          Duration.millis(500),
          Duration.zero
        ])
      }))
  })
})

const run = Effect.fnUntraced(function*<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const fiber = yield* Effect.forkChild(effect)
  yield* TestClock.setTime(Number.POSITIVE_INFINITY)
  return yield* Fiber.join(fiber)
})

const runCollect = Effect.fnUntraced(function*<Output, Input, Error, Env>(
  schedule: Schedule.Schedule<Output, Input, Error, Env>,
  input: Iterable<Input>
) {
  const step = yield* Schedule.toStepWithSleep(schedule)
  const out: Array<Output> = []
  yield* Effect.gen(function*() {
    for (const value of input) {
      out.push(yield* step(value))
    }
  }).pipe(Pull.catchDone((value) => {
    out.push(value as Output)
    return Effect.void
  }))
  return out
}, run)

const runDelays = <Output, Input, Error, Env>(
  schedule: Schedule.Schedule<Output, Input, Error, Env>,
  input: Iterable<Input>
) => runCollect(Schedule.delays(schedule), input)

const runLast = <Output, Input, Error, Env>(
  schedule: Schedule.Schedule<Output, Input, Error, Env>,
  input: Iterable<Input>
) =>
  runCollect(schedule, input).pipe(
    Effect.map((outputs) => outputs[outputs.length - 1])
  )

const format = (timestamp: number | string | Date): string => {
  const date = new Date(timestamp)
  const hours = `0${date.getHours()}`.slice(-2)
  const minutes = `0${date.getMinutes()}`.slice(-2)
  const seconds = `0${date.getSeconds()}`.slice(-2)
  return `${date.toDateString()} ${hours}:${minutes}:${seconds}`
}
