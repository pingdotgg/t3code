import { assert, describe, it } from "@effect/vitest"
import {
  Clock,
  ConfigProvider,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Metric,
  Option,
  Ref,
  Scope
} from "effect"
import { type Headers, HttpBody, HttpClient, type HttpClientError, HttpClientResponse } from "effect/http"
import { Otlp, OtlpExporter, OtlpLogger, OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/observability"
import { TestClock } from "effect/testing"
import * as Version from "effect/Version"

const makeHttpClient = Effect.fnUntraced(function*(retryAfter: string | undefined) {
  const attempts = yield* Ref.make(0)

  const httpClient = HttpClient.makeWith(
    Effect.fnUntraced(function*(requestEffect) {
      const request = yield* requestEffect
      const attempt = yield* Ref.updateAndGet(attempts, (attempts) => attempts + 1)
      if (attempt === 1) {
        return HttpClientResponse.fromWeb(
          request,
          retryAfter === undefined
            ? new Response(null, { status: 429 })
            : new Response(null, { status: 429, headers: { "retry-after": retryAfter } })
        )
      }
      return HttpClientResponse.fromWeb(request, new Response())
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
  )

  return { attempts, httpClient } as const
})

const makeExporter = (
  httpClient: HttpClient.HttpClient,
  options?: {
    readonly exportInterval?: Duration.Input
    readonly maxBatchSize?: number | "disabled"
    readonly maxQueueSize?: number | undefined
    readonly concurrency?: number | "unbounded" | undefined
    readonly onDrop?: ((count: number) => void) | undefined
    readonly shutdownTimeout?: Duration.Input
    readonly body?: (data: Array<any>) => HttpBody.HttpBody
    readonly headers?: Headers.Input | undefined
  }
) =>
  OtlpExporter.make({
    label: "OtlpExporterTest",
    url: "http://localhost:4318/v1/logs",
    headers: options?.headers,
    exportInterval: options?.exportInterval ?? "1 hour",
    maxBatchSize: options?.maxBatchSize ?? 1,
    maxQueueSize: options?.maxQueueSize,
    concurrency: options?.concurrency,
    onDrop: options?.onDrop,
    body: (data) => [options?.body?.(data) ?? HttpBody.empty, Effect.void],
    shutdownTimeout: options?.shutdownTimeout ?? "1 second"
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provide(OtlpExporter.layerFlusher)
  )

const makeExporterRaw = (
  maxBatchSize: number | "disabled" = 1,
  body: (data: Array<any>) => HttpBody.HttpBody = () => HttpBody.empty,
  exportInterval: Duration.Input = "1 hour"
) =>
  OtlpExporter.make({
    label: "OtlpExporterTest",
    url: "http://localhost:4318/v1/logs",
    headers: undefined,
    exportInterval,
    maxBatchSize,
    body: (data) => [body(data), Effect.void],
    shutdownTimeout: "1 second"
  })

const makeStatusHttpClient = Effect.fnUntraced(function*(status: number) {
  const attempts = yield* Ref.make(0)
  const urls = yield* Ref.make<ReadonlyArray<string>>([])

  const httpClient = HttpClient.makeWith(
    Effect.fnUntraced(function*(requestEffect) {
      const request = yield* requestEffect
      yield* Ref.update(attempts, (attempts) => attempts + 1)
      yield* Ref.update(urls, (urls) => [...urls, request.url])
      return HttpClientResponse.fromWeb(request, new Response(null, { status }))
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
  )

  return { attempts, httpClient, urls } as const
})

const yieldNowN = (times: number) =>
  Effect.forEach(Array.from({ length: times }), () => Effect.yieldNow, { discard: true })

const makeControlledHttpClient = Effect.fnUntraced(function*(requestCount: number) {
  const started = yield* Effect.forEach(Array.from({ length: requestCount }), () => Deferred.make<void>())
  const releases = yield* Effect.forEach(Array.from({ length: requestCount }), () => Deferred.make<void>())
  const interrupted = yield* Ref.make(0)
  let requestIndex = 0

  const httpClient = HttpClient.makeWith(
    Effect.fnUntraced(function*(requestEffect) {
      const request = yield* requestEffect
      const index = requestIndex++
      yield* Deferred.succeed(started[index], undefined)
      yield* Deferred.await(releases[index]).pipe(
        Effect.onInterrupt(() => Ref.update(interrupted, (count) => count + 1))
      )
      return HttpClientResponse.fromWeb(request, new Response())
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
  )

  return { httpClient, interrupted, releases, started } as const
})

describe("OtlpExporter", () => {
  it.effect("appends the versioned exporter User-Agent to a user-supplied value", () =>
    Effect.gen(function*() {
      const userAgents: Array<string> = []
      const httpClient = HttpClient.makeWith(
        Effect.fnUntraced(function*(requestEffect) {
          const request = yield* requestEffect
          userAgents.push(request.headers["user-agent"])
          return HttpClientResponse.fromWeb(request, new Response())
        }),
        Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
      )
      yield* Effect.scoped(Effect.gen(function*() {
        const exporter = yield* makeExporter(httpClient, { headers: { "UsEr-AgEnT": "my-app/1.0" }, maxBatchSize: 10 })
        exporter.push({ value: 1 })
      }))
      assert.deepStrictEqual(userAgents, [
        `my-app/1.0 OTel-OTLP-Exporter-JavaScript-Effect-OtlpExporterTest/${Version.getCurrentVersion()}`
      ])
    }))

  it.effect("keeps no background fiber with an infinite interval", () => {
    let activeFibers = 0
    const runtimeMetrics: Metric.FiberRuntimeMetricsService = {
      recordFiberStart: () => {
        activeFibers++
      },
      recordFiberEnd: () => {
        activeFibers--
      }
    }
    return Effect.gen(function*() {
      const { attempts, httpClient } = yield* makeStatusHttpClient(200)
      yield* Effect.scoped(
        Effect.gen(function*() {
          const exporter = yield* makeExporterRaw(2, undefined, Duration.infinity)
          const flusher = yield* OtlpExporter.Flusher
          assert.strictEqual(activeFibers, 0)

          exporter.push({ value: 1 })
          yield* flusher.flush
          assert.strictEqual(yield* Ref.get(attempts), 1)

          exporter.push({ value: 2 })
          exporter.push({ value: 3 })
          yield* yieldNowN(3)
          assert.strictEqual(activeFibers, 0)
          assert.strictEqual(yield* Ref.get(attempts), 2)

          exporter.push({ value: 4 })
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provide(OtlpExporter.layerFlusher)
        )
      )
      assert.strictEqual(yield* Ref.get(attempts), 3)
    }).pipe(Effect.provideService(Metric.FiberRuntimeMetrics, runtimeMetrics))
  })

  it.effect("allows an in-flight timer export to finish during shutdown", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const { httpClient, releases, started } = yield* makeControlledHttpClient(1)
      const exporter = yield* makeExporter(httpClient, {
        exportInterval: "1 second",
        maxBatchSize: 10
      }).pipe(Scope.provide(scope))

      exporter.push({ value: 1 })
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(started[0])

      const closeFiber = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* Effect.yieldNow
      assert.isUndefined(closeFiber.pollUnsafe())

      yield* Deferred.succeed(releases[0], undefined)
      yield* Fiber.join(closeFiber)
    }))

  it.effect("waits for each periodic export before starting the next interval", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const { httpClient, releases, started } = yield* makeControlledHttpClient(3)
      const exporter = yield* makeExporter(httpClient, {
        exportInterval: "1 second",
        maxBatchSize: "disabled"
      }).pipe(Scope.provide(scope))

      exporter.push({ value: 1 })
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(started[0])

      yield* TestClock.adjust("1 second")
      assert.isFalse(yield* Deferred.isDone(started[1]))

      yield* Deferred.succeed(releases[0], undefined)
      exporter.push({ value: 2 })
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(started[1])

      exporter.push({ value: 3 })
      const closeFiber = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* Deferred.succeed(releases[1], undefined)
      yield* Deferred.await(started[2])
      yield* Deferred.succeed(releases[2], undefined)
      yield* Fiber.join(closeFiber)
    }))

  it.effect("keeps an export timer pending only while telemetry is buffered", () =>
    Effect.gen(function*() {
      const { attempts, httpClient } = yield* makeStatusHttpClient(200)
      const testClock = yield* Clock.Clock
      let pendingSleeps = 0
      const clock: Clock.Clock = {
        ...testClock,
        sleep: (duration) =>
          Effect.suspend(() => {
            pendingSleeps++
            return Effect.ensuring(testClock.sleep(duration), Effect.sync(() => pendingSleeps--))
          })
      }
      yield* Effect.scoped(
        Effect.gen(function*() {
          const exporter = yield* makeExporterRaw(10).pipe(Effect.provideService(Clock.Clock, clock))
          const flusher = yield* OtlpExporter.Flusher
          yield* yieldNowN(3)
          assert.strictEqual(pendingSleeps, 0)

          exporter.push({ value: 1 })
          yield* yieldNowN(3)
          assert.strictEqual(pendingSleeps, 1)
          yield* TestClock.adjust("1 hour")
          assert.strictEqual(yield* Ref.get(attempts), 1)
          assert.strictEqual(pendingSleeps, 0)

          exporter.push({ value: 2 })
          yield* flusher.flush
          yield* yieldNowN(3)
          assert.strictEqual(yield* Ref.get(attempts), 2)
          assert.strictEqual(pendingSleeps, 0)
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provide(OtlpExporter.layerFlusher)
        )
      )
    }))

  it.effect("exports again once the disabled window has passed", () =>
    Effect.gen(function*() {
      const { attempts, httpClient } = yield* makeStatusHttpClient(400)
      const exporter = yield* makeExporter(httpClient, { exportInterval: "1 second", maxBatchSize: 10 })

      exporter.push({ value: 1 })
      yield* TestClock.adjust("1 second")
      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* TestClock.adjust("61 seconds")
      exporter.push({ value: 2 })
      yield* TestClock.adjust("1 second")
      assert.strictEqual(yield* Ref.get(attempts), 2)
    }))

  it.effect("allows an in-flight batch export to finish during shutdown", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const { httpClient, releases, started } = yield* makeControlledHttpClient(1)
      const exporter = yield* makeExporter(httpClient).pipe(Scope.provide(scope))

      exporter.push({ value: 1 })
      yield* Deferred.await(started[0])

      const closeFiber = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* Effect.yieldNow
      assert.isUndefined(closeFiber.pollUnsafe())

      yield* Deferred.succeed(releases[0], undefined)
      yield* Fiber.join(closeFiber)
    }))

  it.effect("exports remaining telemetry concurrently and waits for all requests on parallel scope shutdown", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make("parallel")
      const { httpClient, interrupted, releases, started } = yield* makeControlledHttpClient(2)
      const batches: Array<Array<number>> = []
      const exporter = yield* makeExporter(httpClient, {
        maxBatchSize: 2,
        body(data) {
          batches.push(data.map((item) => item.value))
          return HttpBody.empty
        }
      }).pipe(Scope.provide(scope))

      exporter.push({ value: 1 })
      exporter.push({ value: 2 })
      yield* Deferred.await(started[0])
      exporter.push({ value: 3 })

      const closeFiber = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* Deferred.await(started[1])
      assert.strictEqual(yield* Ref.get(interrupted), 0)
      assert.deepStrictEqual(batches, [[1, 2], [3]])

      // Complete out of order: finishing batch 1 must not let shutdown return before batch 0
      yield* Deferred.succeed(releases[1], undefined)
      yield* yieldNowN(3)
      assert.isUndefined(closeFiber.pollUnsafe())

      yield* Deferred.succeed(releases[0], undefined)
      yield* Fiber.join(closeFiber)
    }))

  it.effect("bounds shutdown waiting and interrupts remaining requests", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const { httpClient, interrupted, started } = yield* makeControlledHttpClient(1)
      const exporter = yield* makeExporter(httpClient).pipe(Scope.provide(scope))

      exporter.push({ value: 1 })
      yield* Deferred.await(started[0])

      const closeFiber = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(closeFiber)
      assert.strictEqual(yield* Ref.get(interrupted), 1)
    }))

  it.effect("does not initiate or wait for delivery when disabled", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const { httpClient, releases, started } = yield* makeControlledHttpClient(1)
      const attempts = yield* Ref.make(0)
      const failingClient = HttpClient.makeWith(
        Effect.fnUntraced(function*(requestEffect) {
          const request = yield* requestEffect
          yield* Ref.update(attempts, (count) => count + 1)
          yield* httpClient.execute(request)
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 400 }))
        }),
        Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
      )
      let dropped = 0
      const flusher = yield* OtlpExporter.Flusher
      const exporter = yield* OtlpExporter.make({
        label: "OtlpExporterTest",
        url: "http://localhost:4318/v1/logs",
        headers: undefined,
        exportInterval: "1 hour",
        maxBatchSize: 1,
        maxQueueSize: 4,
        concurrency: 1,
        onDrop: (count) => {
          dropped += count
        },
        body: () => [HttpBody.empty, Effect.void],
        shutdownTimeout: "1 second"
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, failingClient),
        Scope.provide(scope)
      )

      exporter.push({ value: 1 })
      yield* Deferred.await(started[0])
      exporter.push({ value: 2 })
      const flushFiber = yield* Effect.forkChild(flusher.flush)
      yield* yieldNowN(2)
      assert.isUndefined(flushFiber.pollUnsafe())

      yield* Deferred.succeed(releases[0], undefined)
      yield* Fiber.join(flushFiber)
      exporter.push({ value: 3 })

      // After cooldown expires, an idle flush must not hang on discarded queued items
      yield* TestClock.adjust("61 seconds")
      yield* flusher.flush
      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* Scope.close(scope, Exit.void)
      assert.strictEqual(yield* Ref.get(attempts), 1)
      assert.strictEqual(dropped, 0)
    }).pipe(Effect.provide(OtlpExporter.layerFlusher)))

  for (const phase of ["before", "during"] as const) {
    it.effect(`waits for a healthy in-flight sibling on flush and shutdown ${phase} cooldown`, () =>
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const startedA = yield* Deferred.make<void>()
        const startedB = yield* Deferred.make<void>()
        const releaseA = yield* Deferred.make<void>()
        const releaseB = yield* Deferred.make<void>()
        const interruptedA = yield* Ref.make(0)
        const batches: Array<Array<number>> = []
        let requestIndex = 0
        let dropped = 0

        const httpClient = HttpClient.makeWith(
          Effect.fnUntraced(function*(requestEffect) {
            const request = yield* requestEffect
            const index = requestIndex++
            if (index === 0) {
              yield* Deferred.succeed(startedA, undefined)
              yield* Deferred.await(releaseA).pipe(
                Effect.onInterrupt(() => Ref.update(interruptedA, (count) => count + 1))
              )
              return HttpClientResponse.fromWeb(request, new Response())
            }
            yield* Deferred.succeed(startedB, undefined)
            yield* Deferred.await(releaseB)
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 400 }))
          }),
          Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
        )

        const flusher = yield* OtlpExporter.Flusher
        const exporter = yield* OtlpExporter.make({
          label: "OtlpExporterTest",
          url: "http://localhost:4318/v1/logs",
          headers: undefined,
          exportInterval: "1 hour",
          maxBatchSize: 1,
          maxQueueSize: 4,
          concurrency: 2,
          onDrop: (count) => {
            dropped += count
          },
          body(data) {
            batches.push(data.map((item) => item.value))
            return [HttpBody.empty, Effect.void]
          },
          shutdownTimeout: "1 second"
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Scope.provide(scope)
        )

        // Start healthy A and failing B in flight, with C queued behind both slots
        exporter.push({ value: 1 })
        exporter.push({ value: 2 })
        yield* Deferred.await(startedA)
        yield* Deferred.await(startedB)
        exporter.push({ value: 3 })

        if (phase === "during") {
          yield* Deferred.succeed(releaseB, undefined)
          yield* yieldNowN(3)
          exporter.push({ value: 4 })
        }

        const flushFiber = yield* Effect.forkChild(flusher.flush)
        yield* yieldNowN(2)
        const closeFiber = yield* Effect.forkChild(Scope.close(scope, Exit.void))
        yield* yieldNowN(2)

        if (phase === "before") {
          yield* TestClock.adjust("800 millis")
          yield* Deferred.succeed(releaseB, undefined)
          yield* TestClock.adjust("199 millis")
        } else {
          yield* TestClock.adjust("999 millis")
        }

        yield* yieldNowN(3)
        assert.strictEqual(yield* Ref.get(interruptedA), 0)
        assert.isUndefined(flushFiber.pollUnsafe())
        assert.isUndefined(closeFiber.pollUnsafe())
        assert.deepStrictEqual(batches, [[1], [2]])

        if (phase === "before") {
          // Original 1 s shutdown deadline fires at 1,000 ms without restarting when cooldown begins at 800 ms
          yield* TestClock.adjust("1 millis")
          yield* yieldNowN(3)
          assert.isDefined(closeFiber.pollUnsafe())
          yield* Fiber.join(closeFiber)
          yield* Fiber.join(flushFiber)
          assert.strictEqual(yield* Ref.get(interruptedA), 1)
        } else {
          // Healthy sibling A finishes at 999 ms within the 1 s deadline
          yield* Deferred.succeed(releaseA, undefined)
          yield* Fiber.join(flushFiber)
          yield* Fiber.join(closeFiber)
          assert.strictEqual(yield* Ref.get(interruptedA), 0)
        }
        assert.deepStrictEqual(batches, [[1], [2]])
        assert.strictEqual(dropped, 0)
      }).pipe(Effect.provide(OtlpExporter.layerFlusher)))
  }

  it.effect("bounds pending queue separately from in-flight batches and caps concurrency including retries", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const started = yield* Effect.forEach([0, 1, 2, 3], () => Deferred.make<void>())
      const releases = yield* Effect.forEach([0, 1, 2, 3], () => Deferred.make<void>())
      let inFlight = 0
      let maxInFlight = 0
      let attempt = 0
      const batches: Array<Array<number>> = []

      const httpClient = HttpClient.makeWith(
        Effect.fnUntraced(function*(requestEffect) {
          const request = yield* requestEffect
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          const current = attempt++
          if (current < 4) {
            yield* Deferred.succeed(started[current], undefined)
            yield* Deferred.await(releases[current])
          }
          inFlight--
          // First request returns 500 once so retry slot occupation is verified.
          if (current === 0) {
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }))
          }
          return HttpClientResponse.fromWeb(request, new Response())
        }),
        Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
      )

      let dropped = 0
      const exporter = yield* makeExporter(httpClient, {
        maxBatchSize: 2,
        maxQueueSize: 3,
        concurrency: 2,
        onDrop: (count) => {
          dropped += count
        },
        body(data) {
          batches.push(data.map((item) => item.value))
          return HttpBody.empty
        }
      }).pipe(Scope.provide(scope))

      // Fill both concurrency slots: [1, 2] (gate 0) and [3, 4] (gate 1)
      exporter.push({ value: 1 })
      exporter.push({ value: 2 })
      yield* Deferred.await(started[0])
      exporter.push({ value: 3 })
      exporter.push({ value: 4 })
      yield* Deferred.await(started[1])

      // While 4 items are in flight, pending queue still holds maxQueueSize (3) before dropping
      exporter.push({ value: 5 })
      exporter.push({ value: 6 })
      exporter.push({ value: 7 })
      exporter.push({ value: 8 })
      exporter.push({ value: 9 })
      assert.strictEqual(dropped, 2)
      assert.isFalse(yield* Deferred.isDone(started[2]))

      // Batch 0 returns 500 and enters 1s retry backoff; slot stays occupied so [5, 6] cannot start
      yield* Deferred.succeed(releases[0], undefined)
      yield* yieldNowN(3)
      assert.deepStrictEqual(batches, [[1, 2], [3, 4]])
      assert.isFalse(yield* Deferred.isDone(started[2]))

      // Batch 1 settles out of order -> frees a slot for FIFO batch [5, 6] (gate 2)
      yield* Deferred.succeed(releases[1], undefined)
      yield* Deferred.await(started[2])
      assert.deepStrictEqual(batches, [[1, 2], [3, 4], [5, 6]])

      // Advance retry delay -> retry of [1, 2] runs (gate 3) and succeeds
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(started[3])
      yield* Deferred.succeed(releases[3], undefined)
      yield* Deferred.succeed(releases[2], undefined)

      // Remaining [7] drains on shutdown
      yield* Scope.close(scope, Exit.void)
      assert.deepStrictEqual(batches, [[1, 2], [3, 4], [5, 6], [7]])
      assert.strictEqual(maxInFlight, 2)
      assert.strictEqual(dropped, 2)
    }))

  it.effect("serializes overlapping timer and threshold exports when concurrency is 1", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const { httpClient, releases, started } = yield* makeControlledHttpClient(2)
      const batches: Array<Array<number>> = []
      const exporter = yield* makeExporter(httpClient, {
        exportInterval: "1 second",
        maxBatchSize: 2,
        concurrency: 1,
        body(data) {
          batches.push(data.map((item) => item.value))
          return HttpBody.empty
        }
      }).pipe(Scope.provide(scope))

      // Arm timer with item 1, then hit threshold with item 2
      exporter.push({ value: 1 })
      exporter.push({ value: 2 })
      yield* Deferred.await(started[0])

      // Buffer item 3 and fire the interval while [1, 2] is still in flight
      exporter.push({ value: 3 })
      yield* TestClock.adjust("1 second")
      yield* yieldNowN(3)
      assert.isFalse(yield* Deferred.isDone(started[1]))
      assert.deepStrictEqual(batches, [[1, 2]])

      // Once [1, 2] finishes, item 3 exports immediately without starting concurrently
      yield* Deferred.succeed(releases[0], undefined)
      yield* Deferred.await(started[1])
      assert.deepStrictEqual(batches, [[1, 2], [3]])
      yield* Deferred.succeed(releases[1], undefined)
      yield* Scope.close(scope, Exit.void)
    }))

  it.effect("allows unbounded concurrency when explicitly configured", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const { httpClient, releases, started } = yield* makeControlledHttpClient(5)
      const exporter = yield* makeExporter(httpClient, {
        maxBatchSize: 1,
        concurrency: "unbounded"
      }).pipe(Scope.provide(scope))

      for (let i = 0; i < 5; i++) {
        exporter.push({ value: i })
      }
      // All 5 requests (> default 4) start concurrently
      for (let i = 0; i < 5; i++) {
        yield* Deferred.await(started[i])
      }
      for (let i = 0; i < 5; i++) {
        yield* Deferred.succeed(releases[i], undefined)
      }
      yield* Scope.close(scope, Exit.void)
    }))

  it.effect("returns from scope close at shutdownTimeout even with an uninterruptible client", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const started = yield* Effect.forEach([0, 1], () => Deferred.make<void>())
      const gate = yield* Deferred.make<void>()
      const batches: Array<Array<number>> = []
      let requestIndex = 0
      const httpClient = HttpClient.makeWith(
        Effect.fnUntraced(function*(requestEffect) {
          const request = yield* requestEffect
          const index = requestIndex++
          if (index < started.length) {
            yield* Deferred.succeed(started[index], undefined)
          }
          yield* Effect.uninterruptible(Deferred.await(gate))
          return HttpClientResponse.fromWeb(request, new Response())
        }),
        Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
      )
      let dropped = 0
      const exporter = yield* makeExporter(httpClient, {
        maxBatchSize: 1,
        maxQueueSize: 4,
        concurrency: 2,
        shutdownTimeout: "40 millis",
        onDrop: (count) => {
          dropped += count
        },
        body(data) {
          batches.push(data.map((item) => item.value))
          return HttpBody.empty
        }
      }).pipe(Scope.provide(scope))

      exporter.push({ value: 1 })
      exporter.push({ value: 2 })
      yield* Deferred.await(started[0])
      yield* Deferred.await(started[1])
      exporter.push({ value: 3 })

      const closeFiber = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* TestClock.adjust("40 millis")
      yield* Fiber.join(closeFiber)
      assert.isFalse(yield* Deferred.isDone(gate))

      // Releasing the gate after shutdown must not start any queued batch
      yield* Deferred.succeed(gate, undefined)
      yield* yieldNowN(5)
      assert.deepStrictEqual(batches, [[1], [2]])
      assert.strictEqual(dropped, 0)
    }))

  it.effect("normalizes fractional maxBatchSize and NaN limits without wedging or unbounding", () =>
    Effect.gen(function*() {
      const { httpClient } = yield* makeStatusHttpClient(200)
      const batches: Array<Array<number>> = []
      let dropped = 0

      yield* Effect.scoped(Effect.gen(function*() {
        const fractional = yield* makeExporter(httpClient, {
          maxBatchSize: 1.5,
          concurrency: Number.NaN,
          body(data) {
            batches.push(data.map((item) => item.value))
            return HttpBody.empty
          }
        })
        fractional.push({ value: 1 })
        fractional.push({ value: 2 })

        const bounded = yield* makeExporter(httpClient, {
          maxBatchSize: "disabled",
          maxQueueSize: Number.NaN,
          onDrop: (count) => {
            dropped += count
          }
        })
        for (let i = 0; i < 2049; i++) {
          bounded.push({ value: i })
        }
      }))

      assert.deepStrictEqual(batches, [[1], [2]])
      assert.strictEqual(dropped, 1)
    }))

  it.effect("retries status 429 with numeric retry-after delay", () =>
    Effect.gen(function*() {
      const { attempts, httpClient } = yield* makeHttpClient("2")
      const exporter = yield* makeExporter(httpClient)

      exporter.push({ value: 1 })
      yield* yieldNowN(3)

      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* TestClock.adjust("1 second")
      yield* yieldNowN(2)
      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* TestClock.adjust("1 second")
      yield* yieldNowN(2)
      assert.strictEqual(yield* Ref.get(attempts), 2)
    }))

  it.effect("retries status 429 with HTTP-date retry-after delay", () =>
    Effect.gen(function*() {
      const { attempts, httpClient } = yield* makeHttpClient("Thu, 01 Jan 1970 00:01:00 GMT")
      const exporter = yield* makeExporter(httpClient)

      exporter.push({ value: 1 })
      yield* yieldNowN(3)

      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* TestClock.adjust("5 seconds")
      yield* yieldNowN(2)
      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* TestClock.adjust("55 seconds")
      yield* yieldNowN(2)
      assert.strictEqual(yield* Ref.get(attempts), 2)
    }))

  it.effect("uses fallback retry-after delay when header is non-numeric", () =>
    Effect.gen(function*() {
      const { attempts, httpClient } = yield* makeHttpClient("soon")
      const exporter = yield* makeExporter(httpClient)

      exporter.push({ value: 1 })
      yield* yieldNowN(3)

      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* TestClock.adjust("4 seconds")
      yield* yieldNowN(2)
      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* TestClock.adjust("1 second")
      yield* yieldNowN(2)
      assert.strictEqual(yield* Ref.get(attempts), 2)
    }))

  it.effect("uses fallback retry-after delay when header is negative", () =>
    Effect.gen(function*() {
      const { attempts, httpClient } = yield* makeHttpClient("-5")
      const exporter = yield* makeExporter(httpClient)

      exporter.push({ value: 1 })
      yield* yieldNowN(3)

      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* TestClock.adjust("4 seconds")
      yield* yieldNowN(2)
      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* TestClock.adjust("1 second")
      yield* yieldNowN(2)
      assert.strictEqual(yield* Ref.get(attempts), 2)
    }))

  it.effect("uses fallback retry-after delay when header is missing", () =>
    Effect.gen(function*() {
      const { attempts, httpClient } = yield* makeHttpClient(undefined)
      const exporter = yield* makeExporter(httpClient)

      exporter.push({ value: 1 })
      yield* yieldNowN(3)

      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* TestClock.adjust("4 seconds")
      yield* yieldNowN(2)
      assert.strictEqual(yield* Ref.get(attempts), 1)

      yield* TestClock.adjust("1 second")
      yield* yieldNowN(2)
      assert.strictEqual(yield* Ref.get(attempts), 2)
    }))

  describe("flush", () => {
    it.effect("exports buffered items without advancing to the export interval", () =>
      Effect.gen(function*() {
        const { attempts, httpClient } = yield* makeStatusHttpClient(200)
        yield* Effect.scoped(
          Effect.gen(function*() {
            const exporter = yield* makeExporterRaw(10)
            const flusher = yield* OtlpExporter.Flusher
            const before = yield* Clock.currentTimeMillis

            exporter.push({ value: 1 })
            yield* flusher.flush

            assert.strictEqual(yield* Clock.currentTimeMillis, before)
            assert.strictEqual(yield* Ref.get(attempts), 1)
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provide(OtlpExporter.layerFlusher)
          )
        )
      }))

    for (const filterStatus of [false, true]) {
      it.effect(`drains a 429 response before retrying${filterStatus ? " from a status-filtered client" : ""}`, () =>
        Effect.gen(function*() {
          const responses: Array<Response> = []
          const rawClient = HttpClient.make((request) => {
            const response = new Response("body", {
              status: responses.length === 0 ? 429 : 200,
              headers: { "retry-after": "1" }
            })
            responses.push(response)
            return Effect.succeed(HttpClientResponse.fromWeb(request, response))
          })
          const httpClient = filterStatus ? HttpClient.filterStatusOk(rawClient) : rawClient
          yield* Effect.scoped(
            Effect.gen(function*() {
              const exporter = yield* makeExporterRaw(10)
              const flusher = yield* OtlpExporter.Flusher

              exporter.push({ value: 1 })
              const flush = yield* Effect.forkChild(flusher.flush)
              yield* yieldNowN(3)
              assert.strictEqual(responses.length, 1)
              assert.isTrue(responses[0].bodyUsed)

              yield* TestClock.adjust("1 second")
              yield* Fiber.join(flush)
              assert.strictEqual(responses.length, 2)
              assert.isTrue(responses[1].bodyUsed)
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provide(OtlpExporter.layerFlusher)
            )
          )
        }))
    }

    it.effect("keeps exporting when reading a successful response body fails", () =>
      Effect.gen(function*() {
        let attempts = 0
        const httpClient = HttpClient.make((request) => {
          attempts++
          const response = new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("body read failed"))
              }
            })
          )
          return Effect.succeed(HttpClientResponse.fromWeb(request, response))
        })
        yield* Effect.scoped(
          Effect.gen(function*() {
            const exporter = yield* makeExporterRaw(10)
            const flusher = yield* OtlpExporter.Flusher

            exporter.push({ value: 1 })
            yield* flusher.flush
            exporter.push({ value: 2 })
            yield* flusher.flush
            assert.strictEqual(attempts, 2)
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provide(OtlpExporter.layerFlusher)
          )
        )
      }))

    it.effect("does not export empty payloads when batching is disabled", () =>
      Effect.gen(function*() {
        const { httpClient } = yield* makeStatusHttpClient(200)
        const payloads: Array<ReadonlyArray<unknown>> = []

        yield* Effect.scoped(
          Effect.gen(function*() {
            yield* makeExporterRaw("disabled", (items) => {
              payloads.push(items)
              return HttpBody.empty
            })
            const flusher = yield* OtlpExporter.Flusher
            yield* flusher.flush
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provide(OtlpExporter.layerFlusher)
          )
        )

        assert.deepStrictEqual(payloads, [])
      }))

    it.effect("exports buffered items once when batching is disabled", () =>
      Effect.gen(function*() {
        const { httpClient } = yield* makeStatusHttpClient(200)
        const payloads: Array<ReadonlyArray<unknown>> = []

        yield* Effect.scoped(
          Effect.gen(function*() {
            const exporter = yield* makeExporterRaw("disabled", (items) => {
              payloads.push(items)
              return HttpBody.empty
            })
            const flusher = yield* OtlpExporter.Flusher

            exporter.push({ value: 1 })
            yield* flusher.flush
            yield* flusher.flush
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provide(OtlpExporter.layerFlusher)
          )
        )

        assert.deepStrictEqual(payloads, [[{ value: 1 }]])
      }))

    it.effect("shares one registry across traces, logs and metrics", () =>
      Effect.gen(function*() {
        const { httpClient, urls } = yield* makeStatusHttpClient(200)
        const signals = Layer.mergeAll(
          OtlpTracer.layer({
            url: "http://localhost:4318/v1/traces",
            resource: { serviceName: "test" },
            exportInterval: "1 hour",
            maxBatchSize: 100
          }),
          OtlpLogger.layer({
            url: "http://localhost:4318/v1/logs",
            resource: { serviceName: "test" },
            exportInterval: "1 hour",
            maxBatchSize: 100,
            mergeWithExisting: false
          }),
          OtlpMetrics.layer({
            url: "http://localhost:4318/v1/metrics",
            resource: { serviceName: "test" },
            exportInterval: "1 hour"
          })
        ).pipe(
          Layer.provide(OtlpSerialization.layerJson),
          Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, httpClient))
        )

        yield* Effect.gen(function*() {
          yield* Effect.log("flush test")
          yield* Metric.update(Metric.counter("otlp_flush_test"), 1)
          yield* Effect.void.pipe(Effect.withSpan("flush test"))

          const flusher = yield* OtlpExporter.Flusher
          yield* flusher.flush

          assert.deepStrictEqual(
            [...yield* Ref.get(urls)].sort(),
            [
              "http://localhost:4318/v1/logs",
              "http://localhost:4318/v1/metrics",
              "http://localhost:4318/v1/traces"
            ]
          )
        }).pipe(Effect.provide(signals))
      }))

    it.effect("Otlp.layerFromConfig flushes enabled signals when one is disabled", () =>
      Effect.gen(function*() {
        const { httpClient, urls } = yield* makeStatusHttpClient(200)
        const otlp = Otlp.layerFromConfig({
          resource: { serviceName: "test" },
          loggerMergeWithExisting: false
        }).pipe(
          Layer.provide(OtlpSerialization.layerJson),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
            env: {
              OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
              OTEL_LOGS_EXPORTER: "otlp",
              OTEL_METRICS_EXPORTER: "otlp",
              OTEL_TRACES_EXPORTER: "none",
              OTEL_BLRP_SCHEDULE_DELAY: "3600000",
              OTEL_METRIC_EXPORT_INTERVAL: "3600000"
            }
          })))
        )

        yield* Effect.gen(function*() {
          yield* Effect.log("flush test")
          yield* Metric.update(Metric.counter("otlp_flush_test"), 1)
          yield* (yield* OtlpExporter.Flusher).flush

          assert.deepStrictEqual(
            [...yield* Ref.get(urls)].sort(),
            ["http://localhost:4318/v1/logs", "http://localhost:4318/v1/metrics"]
          )
        }).pipe(Effect.provide(otlp))
      }))

    it.effect("is a no-op while the exporter is disabled", () =>
      Effect.gen(function*() {
        const { attempts, httpClient } = yield* makeStatusHttpClient(400)
        yield* Effect.scoped(
          Effect.gen(function*() {
            const exporter = yield* makeExporterRaw(10)
            const flusher = yield* OtlpExporter.Flusher

            exporter.push({ value: 1 })
            yield* flusher.flush
            assert.strictEqual(yield* Ref.get(attempts), 1)

            exporter.push({ value: 2 })
            yield* flusher.flush
            assert.strictEqual(yield* Ref.get(attempts), 1)
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provide(OtlpExporter.layerFlusher)
          )
        )
      }))

    it.effect("deregisters an exporter when its scope closes", () =>
      Effect.gen(function*() {
        const { attempts, httpClient } = yield* makeStatusHttpClient(200)
        const flusher = yield* OtlpExporter.Flusher
        const scope = yield* Scope.make()

        const exporter = yield* makeExporterRaw("disabled").pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(Scope.Scope, scope)
        )
        exporter.push({ value: 1 })

        yield* Scope.close(scope, Exit.void)
        assert.strictEqual(yield* Ref.get(attempts), 1)

        yield* flusher.flush
        assert.strictEqual(yield* Ref.get(attempts), 1)
      }).pipe(Effect.provide(OtlpExporter.layerFlusher)))

    it.effect("succeeds with no registered exporters", () =>
      Effect.gen(function*() {
        const flusher = yield* OtlpExporter.Flusher
        yield* flusher.flush
      }).pipe(Effect.provide(OtlpExporter.layerFlusher)))

    it.effect("is available when the SDK is disabled", () =>
      Effect.gen(function*() {
        const { attempts, httpClient } = yield* makeStatusHttpClient(200)
        const layer = OtlpTracer.layerFromConfig().pipe(
          Layer.provide(OtlpSerialization.layerJson),
          Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, httpClient)),
          Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({
            env: { OTEL_SDK_DISABLED: "true" }
          })))
        )

        yield* Effect.gen(function*() {
          const flusher = yield* OtlpExporter.Flusher
          yield* flusher.flush
        }).pipe(Effect.provide(layer))

        assert.strictEqual(yield* Ref.get(attempts), 0)
      }))

    it.effect("does not fail when the collector returns 500", () =>
      Effect.gen(function*() {
        const { attempts, httpClient } = yield* makeStatusHttpClient(500)
        yield* Effect.scoped(
          Effect.gen(function*() {
            const exporter = yield* makeExporterRaw(10)
            const flusher = yield* OtlpExporter.Flusher

            exporter.push({ value: 1 })
            const fiber = yield* Effect.forkChild(flusher.flush)
            yield* yieldNowN(3)
            yield* TestClock.adjust("3 seconds")
            yield* Fiber.join(fiber)
            assert.strictEqual(yield* Ref.get(attempts), 4)

            yield* flusher.flush
            assert.strictEqual(yield* Ref.get(attempts), 4)
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provide(OtlpExporter.layerFlusher)
          )
        )
      }))

    it.effect("drains in-flight and pre-flush items across out-of-order completion without cancelling", () =>
      Effect.gen(function*() {
        const { httpClient, interrupted, releases, started } = yield* makeControlledHttpClient(4)
        const batches: Array<Array<number>> = []

        yield* Effect.scoped(
          Effect.gen(function*() {
            const exporter = yield* OtlpExporter.make({
              label: "OtlpExporterTest",
              url: "http://localhost:4318/v1/logs",
              headers: undefined,
              exportInterval: "1 hour",
              maxBatchSize: 2,
              concurrency: 2,
              body: (items) => {
                batches.push(items.map((item) => item.value))
                return [HttpBody.empty, Effect.void]
              },
              shutdownTimeout: "1 second"
            })
            const flusher = yield* OtlpExporter.Flusher

            // Fill both concurrency slots: [1, 2] (gate 0) and [3, 4] (gate 1), queue [5, 6]
            exporter.push({ value: 1 })
            exporter.push({ value: 2 })
            yield* Deferred.await(started[0])
            exporter.push({ value: 3 })
            exporter.push({ value: 4 })
            yield* Deferred.await(started[1])
            exporter.push({ value: 5 })
            exporter.push({ value: 6 })

            // An interrupted flush (timeout) must not cancel in-flight exports or drop queued items
            const timedOut = yield* Effect.forkChild(Effect.timeoutOption(flusher.flush, "10 millis"))
            yield* TestClock.adjust("10 millis")
            assert.isTrue(Option.isNone(yield* Fiber.join(timedOut)))
            assert.strictEqual(yield* Ref.get(interrupted), 0)

            // Start a flush covering [1..6], then push [7, 8] after flush started
            const flushFiber = yield* Effect.forkChild(flusher.flush)
            yield* yieldNowN(2)
            assert.isUndefined(flushFiber.pollUnsafe())
            exporter.push({ value: 7 })
            exporter.push({ value: 8 })

            // Complete batch 1 ([3, 4]) out of order -> starts batch 2 ([5, 6]); flush still waits for batch 0
            yield* Deferred.succeed(releases[1], undefined)
            yield* Deferred.await(started[2])
            assert.isUndefined(flushFiber.pollUnsafe())

            // Complete batch 2 ([5, 6]) still before batch 0 -> starts post-flush batch 3 ([7, 8]); flush still waits
            yield* Deferred.succeed(releases[2], undefined)
            yield* Deferred.await(started[3])
            assert.isUndefined(flushFiber.pollUnsafe())

            // Completing batch 0 settles all pre-flush items -> flush returns without waiting for batch 3
            yield* Deferred.succeed(releases[0], undefined)
            yield* Fiber.join(flushFiber)
            assert.deepStrictEqual(batches, [[1, 2], [3, 4], [5, 6], [7, 8]])

            yield* Deferred.succeed(releases[3], undefined)
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provide(OtlpExporter.layerFlusher)
          )
        )
      }))

    it.effect("drains pushed items and still exports empty snapshots when exportEmpty is enabled", () =>
      Effect.gen(function*() {
        const { httpClient } = yield* makeStatusHttpClient(200)
        const payloads: Array<ReadonlyArray<{ value: number }>> = []
        let dropped = 0

        yield* Effect.scoped(
          Effect.gen(function*() {
            const exporter = yield* OtlpExporter.make({
              label: "OtlpExporterTest",
              url: "http://localhost:4318/v1/metrics",
              headers: undefined,
              exportInterval: "1 hour",
              maxBatchSize: "disabled",
              maxQueueSize: 2,
              onDrop: (count) => {
                dropped += count
              },
              exportEmpty: true,
              body: (items) => {
                payloads.push(items)
                return [HttpBody.empty, Effect.void]
              },
              shutdownTimeout: "1 second"
            })
            const flusher = yield* OtlpExporter.Flusher

            exporter.push({ value: 1 })
            yield* flusher.flush
            exporter.push({ value: 2 })
            yield* flusher.flush
            exporter.push({ value: 3 })
            yield* flusher.flush
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provide(OtlpExporter.layerFlusher)
          )
        )

        assert.strictEqual(dropped, 0)
        assert.deepStrictEqual(payloads, [
          [{ value: 1 }],
          [{ value: 2 }],
          [{ value: 3 }],
          []
        ])
      }))
  })
})
