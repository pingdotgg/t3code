import { assert, describe, it } from "@effect/vitest"
import { assertNone, assertSome, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Effect, Schema, Stream } from "effect"
import * as Option from "effect/Option"
import { HttpClientRequest, HttpServerRequest } from "effect/unstable/http"

describe("HttpServerRequest", () => {
  it("toClientRequest", async () => {
    const serverRequest = HttpServerRequest.fromWeb(
      new Request("http://localhost:3000/todos/1?a=1&a=2#top", {
        method: "POST",
        headers: {
          "host": "localhost:3000",
          "content-type": "application/json",
          "content-length": "13",
          "x-test": "ok"
        },
        body: "{\"foo\":\"bar\"}"
      })
    )
    const clientRequest = HttpServerRequest.toClientRequest(serverRequest)

    strictEqual(HttpClientRequest.isHttpClientRequest(clientRequest), true)
    strictEqual(clientRequest.method, "POST")
    strictEqual(clientRequest.url, "http://localhost:3000/todos/1")
    assertSome(clientRequest.hash, "top")
    strictEqual(clientRequest.headers["content-type"], "application/json")
    strictEqual(clientRequest.headers["content-length"], "13")
    strictEqual(clientRequest.headers["x-test"], "ok")
    deepStrictEqual([...clientRequest.urlParams], [["a", "1"], ["a", "2"]])
    strictEqual(clientRequest.body._tag, "Stream")

    if (clientRequest.body._tag === "Stream") {
      strictEqual(
        await Effect.runPromise(clientRequest.body.stream.pipe(
          Stream.decodeText(),
          Stream.mkString
        )),
        "{\"foo\":\"bar\"}"
      )
    }
  })

  it("toClientRequest keeps empty bodies empty", () => {
    const clientRequest = HttpServerRequest.toClientRequest(
      HttpServerRequest.fromWeb(
        new Request("http://localhost:3000/todos/1", {
          method: "GET",
          headers: {
            "content-type": "application/json",
            "x-test": "ok"
          }
        })
      )
    )

    strictEqual(clientRequest.body._tag, "Empty")
    strictEqual(clientRequest.headers["content-type"], "application/json")
    strictEqual(clientRequest.headers["x-test"], "ok")
  })

  it.effect("fromClientRequest preserves request metadata and shares concurrent stream body accessors", () =>
    Effect.gen(function*() {
      const clientRequest = HttpClientRequest.post(new URL("http://localhost:3000/items?existing=1#top")).pipe(
        HttpClientRequest.appendUrlParam("page", "1"),
        HttpClientRequest.setHeader("cookie", "session=123"),
        HttpClientRequest.bodyJsonUnsafe({ foo: "bar" })
      )

      const request = HttpServerRequest.fromClientRequest(clientRequest)
      const arrayBuffer = yield* request.arrayBuffer

      assert.strictEqual(request.source, clientRequest)
      assert.strictEqual(request.method, "POST")
      assert.strictEqual(request.originalUrl, "http://localhost:3000/items?existing=1&page=1#top")
      assert.strictEqual(request.url, "/items?existing=1&page=1#top")
      assert.strictEqual(request.headers["content-type"], "application/json")
      assert.strictEqual(request.cookies.session, "123")
      assert.deepStrictEqual(yield* request.json, { foo: "bar" })
      assert.strictEqual(yield* request.text, "{\"foo\":\"bar\"}")
      assert.strictEqual(new TextDecoder().decode(new Uint8Array(arrayBuffer)), "{\"foo\":\"bar\"}")
    }))

  it.effect("fromClientRequest exposes FormData bodies as multipart parts", () =>
    Effect.gen(function*() {
      const formData = new FormData()
      formData.append("name", "alice")
      formData.append("file", new Blob(["hello"], { type: "text/plain" }), "hello.txt")

      const request = HttpServerRequest.fromClientRequest(
        HttpClientRequest.post("/upload").pipe(
          HttpClientRequest.bodyFormData(formData)
        )
      )
      const parts = yield* Stream.runCollect(request.multipartStream)

      assert.strictEqual(parts.length, 2)
      assert.strictEqual(parts[0]?._tag, "Field")
      if (parts[0]?._tag === "Field") {
        assert.strictEqual(parts[0].key, "name")
        assert.strictEqual(parts[0].value, "alice")
      }
      assert.strictEqual(parts[1]?._tag, "File")
      if (parts[1]?._tag === "File") {
        assert.strictEqual(parts[1].key, "file")
        assert.strictEqual(parts[1].name, "hello.txt")
        assert.strictEqual(parts[1].contentType, "text/plain")
        assert.strictEqual(new TextDecoder().decode(yield* parts[1].contentEffect), "hello")
      }
    }))

  it.effect("schemaBodyJson applies parse options", () =>
    Effect.gen(function*() {
      const request = HttpServerRequest.fromWeb(
        new Request("http://localhost:3000", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            status: "ok",
            name: "svc",
            sha: "abc",
            version: "1.0.0"
          })
        })
      )
      const schema = Schema.Struct({
        status: Schema.String,
        name: Schema.String
      })

      const decoded = yield* HttpServerRequest.schemaBodyJson(schema, { onExcessProperty: "preserve" }).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request)
      )
      const decodedRecord = decoded as Record<string, unknown>

      assert.strictEqual(decoded.status, "ok")
      assert.strictEqual(decoded.name, "svc")
      assert.strictEqual(decodedRecord.sha, "abc")
      assert.strictEqual(decodedRecord.version, "1.0.0")
    }))

  it("remoteAddress defaults to none for web requests", () => {
    const request = HttpServerRequest.fromWeb(new Request("http://example.com"))
    assertNone(request.remoteAddress)
  })

  it("modify distinguishes missing and explicit none remoteAddress", () => {
    const request = HttpServerRequest.fromWeb(new Request("http://example.com"))
    const withRemoteAddress = request.modify({ remoteAddress: Option.some("127.0.0.1") })

    assertSome(withRemoteAddress.remoteAddress, "127.0.0.1")
    assertSome(withRemoteAddress.modify({}).remoteAddress, "127.0.0.1")
    assertNone(withRemoteAddress.modify({ remoteAddress: Option.none() }).remoteAddress)
  })
})
