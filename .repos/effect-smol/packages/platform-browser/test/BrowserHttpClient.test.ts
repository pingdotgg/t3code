import * as BrowserHttpClient from "@effect/platform-browser/BrowserHttpClient"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as Cookies from "effect/unstable/http/Cookies"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as MXHR from "mock-xmlhttprequest"

const layer = (...args: Parameters<typeof MXHR.newServer>) =>
  Layer.unwrap(Effect.sync(() => {
    const server = MXHR.newServer(...args)
    return BrowserHttpClient.layerXMLHttpRequest.pipe(
      Layer.provide(Layer.succeed(BrowserHttpClient.XMLHttpRequest, server.xhrFactory))
    )
  }))

describe("BrowserHttpClient", () => {
  it.effect("json", () =>
    Effect.gen(function*() {
      const body = yield* HttpClient.get("http://localhost:8080/my/url").pipe(
        Effect.flatMap((_) => _.json)
      )
      assert.deepStrictEqual(body, { message: "Success!" })
    }).pipe(Effect.provide(layer({
      get: ["http://localhost:8080/my/url", {
        headers: { "Content-Type": "application/json" },
        body: "{ \"message\": \"Success!\" }"
      }]
    }))))

  it.effect("stream", () =>
    Effect.gen(function*() {
      const body = yield* HttpClient.get("http://localhost:8080/my/url").pipe(
        Effect.flatMap((response) =>
          response.stream.pipe(
            Stream.decodeText(),
            Stream.mkString
          )
        )
      )
      assert.deepStrictEqual(body, "{ \"message\": \"Success!\" }")
    }).pipe(Effect.provide(layer({
      get: ["http://localhost:8080/my/url", {
        headers: { "Content-Type": "application/json" },
        body: "{ \"message\": \"Success!\" }"
      }]
    }))))

  it.effect("cookies", () =>
    Effect.gen(function*() {
      const cookies = yield* HttpClient.get("http://localhost:8080/my/url").pipe(
        Effect.map((response) => response.cookies)
      )
      assert.deepStrictEqual(Cookies.toRecord(cookies), {
        foo: "bar"
      })
    }).pipe(Effect.provide(layer({
      get: ["http://localhost:8080/my/url", {
        headers: { "Content-Type": "application/json", "Set-Cookie": "foo=bar; HttpOnly; Secure" },
        body: "{ \"message\": \"Success!\" }"
      }]
    }))))

  it.effect("arrayBuffer", () =>
    Effect.gen(function*() {
      const body = yield* HttpClient.get("http://localhost:8080/my/url").pipe(
        Effect.flatMap((response) => response.arrayBuffer),
        BrowserHttpClient.withXHRArrayBuffer
      )
      assert.strictEqual(new TextDecoder().decode(body), "{ \"message\": \"Success!\" }")
    }).pipe(Effect.provide(layer({
      get: ["http://localhost:8080/my/url", {
        headers: { "Content-Type": "application/json" },
        body: "{ \"message\": \"Success!\" }"
      }]
    }))))

  it.effect("arrayBuffer without withXHRArrayBuffer", () =>
    Effect.gen(function*() {
      const body = yield* HttpClient.get("http://localhost:8080/my/url").pipe(
        Effect.flatMap((response) => response.arrayBuffer)
      )
      assert.strictEqual(new TextDecoder().decode(body), "{ \"message\": \"Success!\" }")
    }).pipe(Effect.provide(layer({
      get: ["http://localhost:8080/my/url", {
        headers: { "Content-Type": "application/json" },
        body: "{ \"message\": \"Success!\" }"
      }]
    }))))
})
