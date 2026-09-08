import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import * as Tracer from "effect/Tracer"
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

describe("HttpMiddleware", () => {
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
              "x-request": "request"
            }
          })
        )
        const response = HttpServerResponse.empty({
          status: 201,
          headers: { "x-response": "response" }
        })

        yield* HttpMiddleware.tracer(Effect.succeed(response)).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
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
        assert.strictEqual(serverSpan.attributes.get("http.response.status_code"), 201)
        assert.strictEqual(serverSpan.attributes.get("http.response.header.x-response"), "response")
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
