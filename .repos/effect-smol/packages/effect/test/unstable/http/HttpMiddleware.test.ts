import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
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
})
