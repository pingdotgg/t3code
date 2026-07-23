import { assert, describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Effect, Fiber, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { RateLimiter } from "effect/unstable/persistence"

const makeStatusClient = Effect.fnUntraced(function*(status: number) {
  const attempts = yield* Ref.make(0)
  const client = HttpClient.make((request) =>
    Effect.gen(function*() {
      yield* Ref.update(attempts, (n) => n + 1)
      return HttpClientResponse.fromWeb(request, new Response(null, { status }))
    })
  )
  return { attempts, client } as const
})

const RateLimiterTestLayer = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))

describe("HttpClient", () => {
  describe("retryTransient", () => {
    it.effect("retries transient responses with retryOn errors-and-responses", () =>
      Effect.gen(function*() {
        const { attempts, client } = yield* makeStatusClient(503)
        const retryClient = client.pipe(HttpClient.retryTransient({ retryOn: "errors-and-responses", times: 2 }))
        yield* retryClient.get("http://test/").pipe(Effect.ignore)
        strictEqual(yield* Ref.get(attempts), 3)
      }))

    it.effect("does not retry transient responses with retryOn errors-only", () =>
      Effect.gen(function*() {
        const { attempts, client } = yield* makeStatusClient(503)
        const retryClient = client.pipe(HttpClient.retryTransient({ retryOn: "errors-only", times: 2 }))
        yield* retryClient.get("http://test/").pipe(Effect.ignore)
        strictEqual(yield* Ref.get(attempts), 1)
      }))
  })

  describe("stream", () => {
    it.effect("aborts the request when the response stream ends early", () =>
      Effect.gen(function*() {
        let signal: AbortSignal | undefined
        const client = HttpClient.make((request, _url, requestSignal) =>
          Effect.sync(() => {
            signal = requestSignal
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream<Uint8Array>({
                  pull(controller) {
                    controller.enqueue(Uint8Array.of(1))
                  }
                }),
                { status: 200 }
              )
            )
          })
        )

        const response = yield* client.get("http://test/")
        const chunks = yield* response.stream.pipe(
          Stream.take(5),
          Stream.runCollect
        )

        assert.strictEqual(Array.from(chunks).length, 5)
        assert.isTrue(signal!.aborted)
      }))
  })

  describe("withRateLimiter", () => {
    it.effect("delays requests above the configured limit", () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const client = HttpClient.make((request) =>
          Effect.gen(function*() {
            yield* Ref.update(attempts, (n) => n + 1)
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))
          })
        ).pipe(
          HttpClient.withRateLimiter({
            limiter: yield* RateLimiter.RateLimiter,
            key: "test",
            limit: 1,
            window: "1 minute"
          })
        )

        const fiber = yield* client.get("http://test/").pipe(
          Effect.andThen(client.get("http://test/")),
          Effect.forkChild
        )

        yield* TestClock.adjust("59 seconds")
        strictEqual(yield* Ref.get(attempts), 1)

        yield* TestClock.adjust("1 second")
        yield* Fiber.join(fiber)

        strictEqual(yield* Ref.get(attempts), 2)
      }).pipe(Effect.provide(RateLimiterTestLayer)))

    it.effect("updates limits from response headers by default", () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const client = HttpClient.make((request) =>
          Effect.flatMap(
            Ref.updateAndGet(attempts, (n) => n + 1),
            (attempt) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  attempt === 1
                    ? new Response(null, {
                      status: 200,
                      headers: {
                        "x-ratelimit-limit": "1",
                        "x-ratelimit-reset": "60"
                      }
                    })
                    : new Response(null, { status: 200 })
                )
              )
          )
        ).pipe(
          HttpClient.withRateLimiter({
            limiter: yield* RateLimiter.RateLimiter,
            key: "test",
            limit: 10,
            window: "1 minute"
          })
        )

        const fiber = yield* client.get("http://test/").pipe(
          Effect.andThen(client.get("http://test/")),
          Effect.forkChild
        )

        yield* TestClock.adjust("5 seconds")
        strictEqual(yield* Ref.get(attempts), 1)

        yield* TestClock.adjust("1 minute")
        yield* Fiber.join(fiber)
        strictEqual(yield* Ref.get(attempts), 2)
      }).pipe(Effect.provide(RateLimiterTestLayer)))

    it.effect("inspects remaining headers to infer updated limits", () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const limiter = yield* RateLimiter.RateLimiter
        const client = HttpClient.make((request) =>
          Effect.map(
            Ref.updateAndGet(attempts, (n) => n + 1),
            (attempt) =>
              HttpClientResponse.fromWeb(
                request,
                attempt === 1
                  ? new Response(null, {
                    status: 200,
                    headers: {
                      "x-ratelimit-remaining": "0",
                      "x-ratelimit-reset-after": "60"
                    }
                  })
                  : new Response(null, { status: 200 })
              )
          )
        ).pipe(
          HttpClient.withRateLimiter({
            limiter,
            key: "test",
            limit: 10,
            window: "1 minute"
          })
        )

        const fiber = yield* client.get("http://test/").pipe(
          Effect.andThen(client.get("http://test/")),
          Effect.forkChild({ startImmediately: true })
        )

        strictEqual(yield* Ref.get(attempts), 1)

        yield* TestClock.adjust("10 seconds")
        yield* Fiber.join(fiber)
        strictEqual(yield* Ref.get(attempts), 2)
      }).pipe(Effect.provide(RateLimiterTestLayer)))

    it.effect("can disable response header inspection", () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const limiter = yield* RateLimiter.RateLimiter
        const client = HttpClient.make((request) =>
          Effect.flatMap(
            Ref.updateAndGet(attempts, (n) => n + 1),
            () =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(null, {
                    status: 200,
                    headers: {
                      "x-ratelimit-limit": "1",
                      "x-ratelimit-reset": "60"
                    }
                  })
                )
              )
          )
        ).pipe(
          HttpClient.withRateLimiter({
            limiter,
            key: "test",
            limit: 10,
            window: "1 minute",
            disableResponseInspection: true
          })
        )

        yield* client.get("http://test/")
        yield* client.get("http://test/")

        strictEqual(yield* Ref.get(attempts), 2)
      }).pipe(Effect.provide(RateLimiterTestLayer)))

    it.effect("retries 429 responses through the limiter", () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const limiter = yield* RateLimiter.RateLimiter
        const client = HttpClient.make((request) =>
          Effect.flatMap(
            Ref.updateAndGet(attempts, (n) => n + 1),
            (attempt) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(null, {
                    status: attempt === 1 ? 429 : 200
                  })
                )
              )
          )
        ).pipe(
          HttpClient.withRateLimiter({
            limiter,
            key: "test",
            limit: 1,
            window: "1 minute",
            disableResponseInspection: true
          })
        )

        const fiber = yield* client.get("http://test/").pipe(Effect.forkChild)

        yield* TestClock.adjust("59 seconds")
        strictEqual(yield* Ref.get(attempts), 1)

        yield* TestClock.adjust("1 second")
        const response = yield* Fiber.join(fiber)

        strictEqual(response.status, 200)
        strictEqual(yield* Ref.get(attempts), 2)
      }).pipe(Effect.provide(RateLimiterTestLayer)))

    it.effect("retries HttpClientError 429 failures through the limiter", () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const limiter = yield* RateLimiter.RateLimiter
        const client = HttpClient.make((request) =>
          Effect.flatMap(
            Ref.updateAndGet(attempts, (n) => n + 1),
            (attempt) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(null, {
                    status: attempt === 1 ? 429 : 200
                  })
                )
              )
          )
        ).pipe(
          HttpClient.filterStatusOk,
          HttpClient.withRateLimiter({
            limiter,
            key: "test",
            limit: 1,
            window: "1 minute",
            disableResponseInspection: true
          })
        )

        const fiber = yield* client.get("http://test/").pipe(Effect.forkChild)

        yield* TestClock.adjust("59 seconds")
        strictEqual(yield* Ref.get(attempts), 1)

        yield* TestClock.adjust("1 second")
        const response = yield* Fiber.join(fiber)

        strictEqual(response.status, 200)
        strictEqual(yield* Ref.get(attempts), 2)
      }).pipe(Effect.provide(RateLimiterTestLayer)))
  })
})
