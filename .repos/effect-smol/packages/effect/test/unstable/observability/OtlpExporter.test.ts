import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { TestClock } from "effect/testing"
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import type { HttpClientError } from "effect/unstable/http"
import { OtlpExporter } from "effect/unstable/observability"

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

const makeExporter = (httpClient: HttpClient.HttpClient) =>
  OtlpExporter.make({
    label: "OtlpExporterTest",
    url: "http://localhost:4318/v1/logs",
    headers: undefined,
    exportInterval: "1 hour",
    maxBatchSize: 1,
    body: () => HttpBody.empty,
    shutdownTimeout: "1 second"
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))

const yieldNowN = (times: number) =>
  Effect.forEach(Array.from({ length: times }), () => Effect.yieldNow, { discard: true })

describe("OtlpExporter", () => {
  it.effect("retries status 429 with numeric retry-after delay", () =>
    Effect.scoped(
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
      })
    ))

  it.effect("uses fallback retry-after delay when header is non-numeric", () =>
    Effect.scoped(
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
      })
    ))

  it.effect("uses fallback retry-after delay when header is missing", () =>
    Effect.scoped(
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
      })
    ))
})
