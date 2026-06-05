import { assert, describe, it } from "@effect/vitest"
import { Duration, Fiber, Metric, String } from "effect"
import * as Effect from "effect/Effect"
import { TestClock } from "effect/testing"

const attributes = { x: "a", y: "b" }

describe("Metric", () => {
  it.effect("should be referentially transparent", () =>
    Effect.gen(function*() {
      const id = nextId()
      const counter1 = Metric.counter(id).pipe(
        Metric.withAttributes(attributes),
        Metric.withConstantInput(1)
      )
      const counter2 = Metric.counter(id).pipe(
        Metric.withAttributes(attributes),
        Metric.withConstantInput(1)
      )
      const counter3 = Metric.counter(id).pipe(
        Metric.withAttributes({ z: "c" }),
        Metric.withConstantInput(1)
      )
      yield* Effect.track(Effect.void, counter1)
      yield* Effect.track(Effect.void, counter2)
      yield* Effect.track(Effect.void, counter3)
      const result1 = yield* Metric.value(counter1)
      const result2 = yield* Metric.value(counter2)
      const result3 = yield* Metric.value(counter3)
      assert.deepStrictEqual(result1, { count: 2, incremental: false })
      assert.deepStrictEqual(result2, { count: 2, incremental: false })
      assert.deepStrictEqual(result3, { count: 1, incremental: false })
    }))

  it.effect("should dump the current state of all metrics", () =>
    Effect.gen(function*() {
      const counter1 = Metric.counter("counter").pipe(
        Metric.withAttributes(attributes),
        Metric.withConstantInput(1)
      )
      const counter2 = Metric.counter("counter").pipe(
        Metric.withAttributes(attributes),
        Metric.withConstantInput(1)
      )
      const counter3 = Metric.counter("counter").pipe(
        Metric.withAttributes({ z: "c" }),
        Metric.withConstantInput(1)
      )

      yield* Effect.track(Effect.void, counter1)
      yield* Effect.track(Effect.void, counter2)
      yield* Effect.track(Effect.void, counter3)

      const result = yield* Metric.dump
      const expected = String.stripMargin(
        `|name=counter  description=  type=Counter  attributes=[x: a, y: b]  state=[count: [2]]
         |name=counter  description=  type=Counter  attributes=[z: c]        state=[count: [1]]`
      )

      assert.strictEqual(result, expected)
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))

  it.effect("should record fiber runtime metrics once for yielded fibers", () => {
    let starts = 0
    let ends = 0
    const service: Metric.FiberRuntimeMetricsService = {
      recordFiberStart: () => {
        starts++
      },
      recordFiberEnd: () => {
        ends++
      }
    }

    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.gen(function*() {
        yield* Effect.yieldNow
        yield* Effect.yieldNow
      }))

      yield* Fiber.join(fiber)

      assert.strictEqual(starts, 1)
      assert.strictEqual(ends, 1)
    }).pipe(Effect.provideService(Metric.FiberRuntimeMetrics, service))
  })

  describe("Counter", () => {
    it.effect("custom increment with value", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(
          Metric.withAttributes(attributes)
        )
        yield* Effect.trackSuccesses(Effect.succeed(1), counter)
        yield* Effect.trackSuccesses(Effect.succeed(2), counter)
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 3, incremental: false })
      }))

    it.effect("custom increment with constant", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(1)
        )
        yield* Effect.trackSuccesses(Effect.succeed(1), counter)
        yield* Effect.trackSuccesses(Effect.succeed(2), counter)
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 2, incremental: false })
      }))

    it.effect("custom decrement with value", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(
          Metric.withAttributes(attributes)
        )
        yield* Effect.trackSuccesses(Effect.succeed(-1), counter)
        yield* Effect.trackSuccesses(Effect.succeed(-2), counter)
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: -3, incremental: false })
      }))

    it.effect("custom decrement with constant", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(-1)
        )
        yield* Effect.trackSuccesses(Effect.succeed(-1), counter)
        yield* Effect.trackSuccesses(Effect.succeed(-2), counter)
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: -2, incremental: false })
      }))

    it.effect("custom increment with bigint value", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id, { bigint: true }).pipe(
          Metric.withAttributes(attributes)
        )
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(1)), counter)
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(2)), counter)
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: BigInt(3), incremental: false })
      }))

    it.effect("custom increment with bigint constant", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id, { bigint: true }).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(BigInt(1))
        )
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(1)), counter)
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(2)), counter)
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: BigInt(2), incremental: false })
      }))

    it.effect("custom decrement with bigint value", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id, { bigint: true }).pipe(
          Metric.withAttributes(attributes)
        )
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(-1)), counter)
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(-2)), counter)
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: BigInt(-3), incremental: false })
      }))

    it.effect("custom decrement with bigint constant", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id, { bigint: true }).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(BigInt(-1))
        )
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(-1)), counter)
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(-2)), counter)
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: BigInt(-2), incremental: false })
      }))

    it.effect("fails to decrement incremental counter", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id, { incremental: true }).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(-1)
        )
        yield* Effect.trackSuccesses(Effect.succeed(-1), counter)
        yield* Effect.trackSuccesses(Effect.succeed(-2), counter)
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 0, incremental: true })
      }))

    it.effect("fails to decrement incremental bigint counter", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id, { bigint: true, incremental: true }).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(BigInt(-1))
        )
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(-1)), counter)
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(-2)), counter)
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: BigInt(0), incremental: true })
      }))
  })

  describe("Gauge", () => {
    it.effect("custom set with value", () =>
      Effect.gen(function*() {
        const id = nextId()
        const gauge = Metric.gauge(id).pipe(
          Metric.withAttributes(attributes)
        )
        yield* Effect.trackSuccesses(Effect.succeed(1), gauge)
        yield* Effect.trackSuccesses(Effect.succeed(2), gauge)
        const result = yield* Metric.value(gauge)
        assert.deepStrictEqual(result, { value: 2 })
      }))

    it.effect("custom set with constant", () =>
      Effect.gen(function*() {
        const id = nextId()
        const gauge = Metric.gauge(id).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(1)
        )
        yield* Effect.trackSuccesses(Effect.succeed(1), gauge)
        yield* Effect.trackSuccesses(Effect.succeed(2), gauge)
        const result = yield* Metric.value(gauge)
        assert.deepStrictEqual(result, { value: 1 })
      }))

    it.effect("custom set with negative value", () =>
      Effect.gen(function*() {
        const id = nextId()
        const gauge = Metric.gauge(id).pipe(
          Metric.withAttributes(attributes)
        )
        yield* Effect.trackSuccesses(Effect.succeed(-1), gauge)
        yield* Effect.trackSuccesses(Effect.succeed(-2), gauge)
        const result = yield* Metric.value(gauge)
        assert.deepStrictEqual(result, { value: -2 })
      }))

    it.effect("custom set with negative constant", () =>
      Effect.gen(function*() {
        const id = nextId()
        const gauge = Metric.gauge(id).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(-1)
        )
        yield* Effect.trackSuccesses(Effect.succeed(-1), gauge)
        yield* Effect.trackSuccesses(Effect.succeed(-2), gauge)
        const result = yield* Metric.value(gauge)
        assert.deepStrictEqual(result, { value: -1 })
      }))

    it.effect("custom set with bigint value", () =>
      Effect.gen(function*() {
        const id = nextId()
        const gauge = Metric.gauge(id, { bigint: true }).pipe(
          Metric.withAttributes(attributes)
        )
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(1)), gauge)
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(2)), gauge)
        const result = yield* Metric.value(gauge)
        assert.deepStrictEqual(result, { value: BigInt(2) })
      }))

    it.effect("custom set with bigint constant", () =>
      Effect.gen(function*() {
        const id = nextId()
        const gauge = Metric.gauge(id, { bigint: true }).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(BigInt(1))
        )
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(1)), gauge)
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(2)), gauge)
        const result = yield* Metric.value(gauge)
        assert.deepStrictEqual(result, { value: BigInt(1) })
      }))

    it.effect("custom set with negative bigint value", () =>
      Effect.gen(function*() {
        const id = nextId()
        const gauge = Metric.gauge(id, { bigint: true }).pipe(
          Metric.withAttributes(attributes)
        )
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(-1)), gauge)
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(-2)), gauge)
        const result = yield* Metric.value(gauge)
        assert.deepStrictEqual(result, { value: BigInt(-2) })
      }))

    it.effect("custom set with negative bigint constant", () =>
      Effect.gen(function*() {
        const id = nextId()
        const gauge = Metric.gauge(id, { bigint: true }).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(BigInt(-1))
        )
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(-1)), gauge)
        yield* Effect.trackSuccesses(Effect.succeed(BigInt(-2)), gauge)
        const result = yield* Metric.value(gauge)
        assert.deepStrictEqual(result, { value: BigInt(-1) })
      }))
  })

  describe("Frequency", () => {
    it.effect("custom occurence with value", () =>
      Effect.gen(function*() {
        const id = nextId()
        const frequency = Metric.frequency(id).pipe(
          Metric.withAttributes(attributes)
        )
        yield* Effect.trackSuccesses(Effect.succeed("foo"), frequency)
        yield* Effect.trackSuccesses(Effect.succeed("bar"), frequency)
        const result = yield* Metric.value(frequency)
        assert.deepStrictEqual(result, {
          occurrences: new Map([["foo", 1], ["bar", 1]])
        })
      }))

    it.effect("custom set with constant", () =>
      Effect.gen(function*() {
        const id = nextId()
        const frequency = Metric.frequency(id).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput("constant")
        )
        yield* Effect.trackSuccesses(Effect.succeed("foo"), frequency)
        yield* Effect.trackSuccesses(Effect.succeed("bar"), frequency)
        const result = yield* Metric.value(frequency)
        assert.deepStrictEqual(result, {
          occurrences: new Map([["constant", 2]])
        })
      }))
  })

  describe("Histogram", () => {
    it.effect("custom observe with value", () =>
      Effect.gen(function*() {
        const id = nextId()
        const boundaries = Metric.linearBoundaries({ start: 0, width: 1, count: 10 })
        const histogram = Metric.histogram(id, { boundaries }).pipe(
          Metric.withAttributes(attributes)
        )
        yield* Effect.trackSuccesses(Effect.succeed(1), histogram)
        yield* Effect.trackSuccesses(Effect.succeed(3), histogram)
        const result = yield* Metric.value(histogram)
        assert.deepStrictEqual(result, {
          buckets: makeBuckets(boundaries, [1, 3]),
          count: 2,
          sum: 4,
          min: 1,
          max: 3
        })
      }))

    it.effect("custom observe with constant", () =>
      Effect.gen(function*() {
        const id = nextId()
        const boundaries = Metric.linearBoundaries({ start: 0, width: 1, count: 10 })
        const histogram = Metric.histogram(id, { boundaries }).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(1)
        )
        yield* Effect.trackSuccesses(Effect.succeed(1), histogram)
        yield* Effect.trackSuccesses(Effect.succeed(3), histogram)
        const result = yield* Metric.value(histogram)
        assert.deepStrictEqual(result, {
          buckets: makeBuckets(boundaries, [1, 1]),
          count: 2,
          sum: 2,
          min: 1,
          max: 1
        })
      }))

    it.effect("preserves precision of boundary values", () =>
      Effect.gen(function*() {
        const boundaries = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1]

        const histogram = Metric.histogram("precision_test", { boundaries })

        const result = yield* Metric.value(histogram)

        result.buckets.forEach(([boundary], index) => {
          if (index < boundaries.length) {
            assert.strictEqual(boundary, boundaries[index])
          }
        })
      }))
  })

  describe("Summary", () => {
    it.effect("custom observe with value", () =>
      Effect.gen(function*() {
        const id = nextId()
        const quantiles = [0, 0.1, .9]
        const summary = Metric.summary(id, {
          maxAge: "1 minute",
          maxSize: 10,
          quantiles
        }).pipe(Metric.withAttributes(attributes))
        yield* Effect.trackSuccesses(Effect.succeed(1), summary)
        yield* Effect.trackSuccesses(Effect.succeed(3), summary)
        const result = yield* Metric.value(summary)
        assert.deepStrictEqual(result, {
          quantiles: [[0, 1], [0.1, 1], [0.9, 3]],
          count: 2,
          sum: 4,
          min: 1,
          max: 3
        })
      }))

    it.effect("custom observe with constant", () =>
      Effect.gen(function*() {
        const id = nextId()
        const quantiles = [0, 0.1, .9]
        const summary = Metric.summary(id, {
          maxAge: "1 minute",
          maxSize: 10,
          quantiles
        }).pipe(
          Metric.withAttributes(attributes),
          Metric.withConstantInput(1)
        )
        yield* Effect.trackSuccesses(Effect.succeed(1), summary)
        yield* Effect.trackSuccesses(Effect.succeed(3), summary)
        const result = yield* Metric.value(summary)
        assert.deepStrictEqual(result, {
          quantiles: [[0, 1], [0.1, 1], [0.9, 1]],
          count: 2,
          sum: 2,
          min: 1,
          max: 1
        })
      }))

    it.effect("should return the correct quantile when the first chunk overshoots", () =>
      Effect.gen(function*() {
        const id = nextId()
        const samples = [10, 10, 10, 10, 10, 10, 20, 30, 40, 50]
        const summary = Metric.summary(id, {
          maxAge: "1 minute",
          maxSize: 15,
          quantiles: [0.5]
        })
        yield* Effect.forEach(samples, (sample) => Metric.update(summary, sample))
        const result = yield* Metric.value(summary)
        assert.deepStrictEqual(result, {
          quantiles: [[0.5, 10]],
          count: 10,
          min: 10,
          max: 50,
          sum: 200
        })
      }))
  })

  describe("track", () => {
    it.effect("updates on success", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(Metric.withConstantInput(1))
        yield* Effect.succeed(1).pipe(
          Effect.track(counter)
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 1, incremental: false })
      }))

    it.effect("updates on failure", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(Metric.withConstantInput(1))
        yield* Effect.fail(1).pipe(
          Effect.track(counter),
          Effect.exit
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 1, incremental: false })
      }))

    it.effect("updates on defect", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(Metric.withConstantInput(1))
        yield* Effect.die(1).pipe(
          Effect.track(counter),
          Effect.exit
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 1, incremental: false })
      }))
  })

  describe("track", () => {
    it.effect("maps exits while preserving the instrumented effect result", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(
          Metric.withConstantInput(1)
        )
        yield* Effect.succeed(1).pipe(
          Effect.track(counter)
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 1, incremental: false })
      }))

    it.effect("updates on failure", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(
          Metric.withConstantInput(1)
        )
        yield* Effect.fail(1).pipe(
          Effect.track(counter),
          Effect.exit
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 1, incremental: false })
      }))

    it.effect("updates on defect", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(
          Metric.withConstantInput(1)
        )
        yield* Effect.die(1).pipe(
          Effect.track(counter),
          Effect.exit
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 1, incremental: false })
      }))
  })

  describe("trackErrors", () => {
    it.effect("does not update on success", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(Metric.withConstantInput(1))
        yield* Effect.succeed(1).pipe(
          Effect.trackErrors(counter)
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 0, incremental: false })
      }))

    it.effect("updates on failure", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(Metric.withConstantInput(1))
        yield* Effect.fail(1).pipe(
          Effect.trackErrors(counter),
          Effect.exit
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 1, incremental: false })
      }))

    it.effect("does not update on defect", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(Metric.withConstantInput(1))
        yield* Effect.die(1).pipe(
          Effect.trackErrors(counter),
          Effect.exit
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 0, incremental: false })
      }))
  })

  describe("trackDefects", () => {
    it.effect("does not update on success", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(Metric.withConstantInput(1))
        yield* Effect.succeed(1).pipe(
          Effect.trackDefects(counter)
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 0, incremental: false })
      }))

    it.effect("does not update on failure", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(Metric.withConstantInput(1))
        yield* Effect.fail(1).pipe(
          Effect.trackDefects(counter),
          Effect.exit
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 0, incremental: false })
      }))

    it.effect("updates on defect", () =>
      Effect.gen(function*() {
        const id = nextId()
        const counter = Metric.counter(id).pipe(Metric.withConstantInput(1))
        yield* Effect.die(1).pipe(
          Effect.trackDefects(counter),
          Effect.exit
        )
        const result = yield* Metric.value(counter)
        assert.deepStrictEqual(result, { count: 1, incremental: false })
      }))
  })

  describe("trackDuration", () => {
    it.effect("tracks execution duration", () =>
      Effect.gen(function*() {
        const id = nextId()
        const timer = Metric.timer(id)
        const fiber = yield* Effect.sleep("1 hour").pipe(
          Effect.trackDuration(timer),
          Effect.forkChild
        )
        yield* TestClock.adjust("1 hour")
        yield* Fiber.join(fiber)
        const result = yield* Metric.value(timer)
        assert.strictEqual(result.count, 1)
        assert.strictEqual(result.min, Duration.toMillis(Duration.hours(1)))
        assert.strictEqual(result.max, Duration.toMillis(Duration.hours(1)))
        assert.strictEqual(result.sum, Duration.toMillis(Duration.hours(1)))
      }))
  })

  describe("trackDurationWith", () => {
    it.effect("tracks execution duration", () =>
      Effect.gen(function*() {
        const id = nextId()
        const gauge = Metric.gauge(id)
        const fiber = yield* Effect.sleep("1 hour").pipe(
          Effect.trackDuration(gauge, (duration) => Duration.toMinutes(duration)),
          Effect.forkChild
        )
        yield* TestClock.adjust("1 hour")
        yield* Fiber.join(fiber)
        const result = yield* Metric.value(gauge)
        assert.deepStrictEqual(result, { value: 60 })
      }))
  })
})

let idCounter = 0
function nextId() {
  return `metric-${++idCounter}`
}

const makeBuckets = (
  boundaries: ReadonlyArray<number>,
  values: ReadonlyArray<number>
): ReadonlyArray<[number, number]> => {
  const results: Array<[number, number]> = []
  let count = 0
  let index = 0
  for (const bucket of boundaries) {
    while (index < values.length && values[index] <= bucket) {
      count++
      index++
    }
    results.push([bucket, count])
  }
  return results
}
