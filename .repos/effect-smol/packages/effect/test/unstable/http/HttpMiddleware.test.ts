import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import * as Tracer from "effect/Tracer"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpEffect from "effect/unstable/http/HttpEffect"
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

describe("HttpMiddleware", () => {
  describe("cors", () => {
    it.effect.each([
      {
        name: "adds Origin when Vary is absent",
        vary: undefined,
        expected: "Origin"
      },
      {
        name: "preserves existing Vary dimensions when adding Origin",
        vary: "Accept-Language",
        expected: "Accept-Language, Origin"
      },
      {
        name: "preserves other dimensions without duplicating a mixed-case Origin",
        vary: "Accept-Language, oRiGiN",
        expected: "Accept-Language, oRiGiN"
      },
      {
        name: "preserves wildcard Vary",
        vary: "*",
        expected: "*"
      }
    ])("$name", ({ expected, vary }) =>
      Effect.gen(function*() {
        const handler = HttpEffect.toWebHandler(
          Effect.succeed(HttpServerResponse.text("hello", {
            headers: vary === undefined ? {} : { Vary: vary }
          })).pipe(HttpMiddleware.cors({
            allowedOrigins: ["https://client.example", "https://other.example"]
          }))
        )
        const response = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/", {
              headers: { Origin: "https://client.example" }
            })
          )
        )
        assert.strictEqual(response.headers.get("access-control-allow-origin"), "https://client.example")
        assert.strictEqual(response.headers.get("vary"), expected)
      }))

    it.effect("preserves both Vary dimensions for preflight requests", () =>
      Effect.gen(function*() {
        const handler = HttpEffect.toWebHandler(
          Effect.succeed(HttpServerResponse.empty()).pipe(HttpMiddleware.cors({
            allowedOrigins: ["https://client.example", "https://other.example"]
          }))
        )
        const response = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/", {
              method: "OPTIONS",
              headers: {
                Origin: "https://client.example",
                "Access-Control-Request-Headers": "X-Test"
              }
            })
          )
        )
        const vary = response.headers.get("vary")?.split(",").map((member) => member.trim().toLowerCase()).sort()
        assert.deepStrictEqual(vary, ["access-control-request-headers", "origin"])
      }))

    it.effect("varies by Origin when the request origin is rejected", () =>
      Effect.gen(function*() {
        const handler = HttpEffect.toWebHandler(
          Effect.succeed(HttpServerResponse.empty()).pipe(HttpMiddleware.cors({
            allowedOrigins: ["https://client.example", "https://other.example"]
          }))
        )
        const response = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/", {
              headers: { Origin: "https://rejected.example" }
            })
          )
        )
        assert.strictEqual(response.headers.get("vary"), "Origin")
      }))

    it.effect("preserves Vary when allowing all origins", () =>
      Effect.gen(function*() {
        const handler = HttpEffect.toWebHandler(
          Effect.succeed(HttpServerResponse.text("hello", {
            headers: { Vary: "Accept-Language" }
          })).pipe(HttpMiddleware.cors())
        )
        const response = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/", {
              headers: { Origin: "https://client.example" }
            })
          )
        )
        assert.strictEqual(response.headers.get("access-control-allow-origin"), "*")
        assert.strictEqual(response.headers.get("vary"), "Accept-Language")
      }))
  })

  describe("logger", () => {
    it.effect("annotates method, path, and status without query or hash", () =>
      Effect.gen(function*() {
        const annotations: Array<Record<string, unknown>> = []
        const logger = Logger.make<unknown, void>((options) => {
          annotations.push({ ...options.fiber.getRef(References.CurrentLogAnnotations) })
        })

        const request = HttpServerRequest.fromWeb(
          new Request("http://localhost:3000/todos/1?foo=bar#top", {
            method: "GET"
          })
        )

        yield* HttpMiddleware.logger(
          Effect.succeed(HttpServerResponse.empty({ status: 204 }))
        ).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provide(Logger.layer([logger]))
        )

        assert.strictEqual(annotations.length, 1)
        assert.strictEqual(annotations[0]?.["http.method"], "GET")
        assert.strictEqual(annotations[0]?.["http.url"], "/todos/1")
        assert.strictEqual(annotations[0]?.["http.status"], 204)
      }))

    it.effect("uses a stable http.span log span name", () =>
      Effect.gen(function*() {
        const spans: Array<Array<string>> = []
        const logger = Logger.make<unknown, void>((options) => {
          spans.push(options.fiber.getRef(References.CurrentLogSpans).map(([label]) => label))
        })

        const loggedApp = HttpMiddleware.logger(
          Effect.succeed(HttpServerResponse.empty({ status: 204 }))
        ).pipe(Effect.provide(Logger.layer([logger])))

        const request1 = HttpServerRequest.fromWeb(new Request("http://localhost:3000/one"))
        const request2 = HttpServerRequest.fromWeb(new Request("http://localhost:3000/two"))

        yield* loggedApp.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request1))
        yield* loggedApp.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request2))

        assert.deepStrictEqual(spans, [["http.span"], ["http.span"]])
      }))
  })

  describe("tracer", () => {
    it.effect("restores the ParentSpan context identity", () => {
      const request = HttpServerRequest.fromWeb(new Request("http://localhost:3000/"))
      return Effect.gen(function*() {
        const before = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.context))
        let during: typeof before | undefined

        yield* HttpMiddleware.tracer(
          Effect.withFiber((fiber) => {
            during = fiber.context
            assert.strictEqual(Context.getOrUndefined(fiber.context, Tracer.ParentSpan) !== undefined, true)
            return Effect.succeed(HttpServerResponse.empty())
          })
        )

        const after = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.context))
        assert.notStrictEqual(during, before)
        assert.strictEqual(after, before)
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
    })

    it.effect("records attributes for sampled spans", () =>
      Effect.gen(function*() {
        let serverSpan: Tracer.NativeSpan | undefined
        const tracer = Tracer.make({
          span(options) {
            serverSpan = new Tracer.NativeSpan(options)
            return serverSpan
          }
        })
        const request = HttpServerRequest.fromWeb(
          new Request("https://localhost:3000/todos/1?foo=bar", {
            method: "POST",
            headers: {
              "user-agent": "test-agent",
              "x-request": "request",
              "x-request-secret": "request-secret"
            }
          })
        )
        const response = HttpServerResponse.empty({
          status: 201,
          headers: {
            "x-response": "response",
            "x-response-secret": "response-secret"
          }
        })

        yield* HttpMiddleware.tracer(Effect.succeed(response)).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provideService(Headers.CurrentRedactedNames, ["x-request-secret", "x-response-secret"]),
          Effect.provideService(Tracer.Tracer, tracer)
        )
        yield* Effect.yieldNow

        assert(serverSpan !== undefined)
        assert.strictEqual(serverSpan.sampled, true)
        assert.strictEqual(serverSpan.attributes.get("http.request.method"), "POST")
        assert.strictEqual(serverSpan.attributes.get("url.path"), "/todos/1")
        assert.strictEqual(serverSpan.attributes.get("url.query"), "foo=bar")
        assert.strictEqual(serverSpan.attributes.get("user_agent.original"), "test-agent")
        assert.strictEqual(serverSpan.attributes.get("http.request.header.x-request"), "request")
        assert.strictEqual(serverSpan.attributes.get("http.request.header.x-request-secret"), "<redacted>")
        assert.strictEqual(serverSpan.attributes.get("http.response.status_code"), 201)
        assert.strictEqual(serverSpan.attributes.get("http.response.header.x-response"), "response")
        assert.strictEqual(serverSpan.attributes.get("http.response.header.x-response-secret"), "<redacted>")
      }))

    it.effect("skips attributes for unsampled spans", () =>
      Effect.gen(function*() {
        let serverSpan: Tracer.NativeSpan | undefined
        const tracer = Tracer.make({
          span(options) {
            serverSpan = new Tracer.NativeSpan(options)
            return serverSpan
          }
        })
        const request = HttpServerRequest.fromWeb(new Request("http://localhost:3000/unsampled"))

        yield* HttpMiddleware.tracer(Effect.succeed(HttpServerResponse.empty({ status: 204 }))).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provideService(Tracer.MinimumTraceLevel, "Fatal"),
          Effect.provideService(Tracer.Tracer, tracer)
        )
        yield* Effect.yieldNow

        assert(serverSpan !== undefined)
        assert.strictEqual(serverSpan.sampled, false)
        assert.strictEqual(serverSpan.attributes.size, 0)
        assert.strictEqual(serverSpan.status._tag, "Ended")
      }))

    it.effect("excludes the sent response from a failed stream span", () =>
      Effect.gen(function*() {
        let serverSpan: Tracer.NativeSpan | undefined
        const tracer = Tracer.make({
          span(options) {
            serverSpan = new Tracer.NativeSpan(options)
            return serverSpan
          }
        })
        const request = HttpServerRequest.fromWeb(new Request("http://localhost:3000/stream"))
        const response = HttpServerResponse.empty({
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
        const streamError = new Error("stream failed")

        // Once headers have been sent, the platform attaches the response to
        // the stream failure so the server can finish the request correctly.
        const app = Effect.failCause(Cause.combine(Cause.fail(streamError), Cause.die(response)))

        yield* Effect.exit(
          HttpMiddleware.tracer(app).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            Effect.provideService(Tracer.Tracer, tracer)
          )
        )
        yield* Effect.yieldNow

        assert(serverSpan !== undefined)
        assert.strictEqual(serverSpan.attributes.get("http.response.status_code"), 200)
        assert.strictEqual(serverSpan.status._tag, "Ended")
        if (serverSpan.status._tag === "Ended") {
          assert.deepStrictEqual(serverSpan.status.exit, Exit.fail(streamError))
        }
      }))
  })
})
