import { assert, describe, it } from "@effect/vitest"
import { Effect, References, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse, HttpServerResponse } from "effect/unstable/http"

describe("HttpServerResponse", () => {
  it.effect("fromClientResponse preserves status, headers, cookies, and json", () =>
    Effect.gen(function*() {
      const request = HttpClientRequest.get("http://localhost:3000/todos/1")
      const clientResponse = HttpServerResponse.toClientResponse(
        HttpServerResponse.jsonUnsafe({ foo: "bar" }, { status: 201 }).pipe(
          HttpServerResponse.setHeader("x-test", "ok"),
          HttpServerResponse.setCookieUnsafe("session", "123")
        ),
        { request }
      )

      const response = HttpServerResponse.fromClientResponse(clientResponse)
      const roundTrip = HttpServerResponse.toClientResponse(response, { request })

      assert.strictEqual(response.status, 201)
      assert.strictEqual(response.headers["content-type"], "application/json")
      assert.strictEqual(response.headers["x-test"], "ok")
      assert.strictEqual(response.headers["set-cookie"], undefined)
      assert.strictEqual(response.cookies.cookies.session?.value, "123")
      assert.deepStrictEqual(yield* roundTrip.json, { foo: "bar" })
    }))

  it.effect("fromClientResponse preserves stream requirements", () =>
    Effect.gen(function*() {
      const clientResponse = HttpServerResponse.toClientResponse(
        HttpServerResponse.stream(
          Stream.fromEffect(References.CurrentConcurrency).pipe(
            Stream.map(String),
            Stream.encodeText
          )
        )
      )

      const response = HttpServerResponse.fromClientResponse(clientResponse)
      const roundTrip = HttpServerResponse.toClientResponse(response)
      const text = yield* roundTrip.text.pipe(
        Effect.provideService(References.CurrentConcurrency, 420)
      )

      assert.strictEqual(text, "420")
    }))

  it.effect("fromClientResponse preserves formData bodies", () =>
    Effect.gen(function*() {
      const formData = new FormData()
      formData.set("foo", "bar")

      const response = HttpServerResponse.fromClientResponse(
        HttpServerResponse.toClientResponse(HttpServerResponse.formData(formData))
      )
      const roundTrip = HttpServerResponse.toClientResponse(response)
      const parsed = yield* roundTrip.formData

      assert.strictEqual(
        response.headers["content-type"]?.startsWith("multipart/form-data; boundary="),
        true
      )
      assert.strictEqual(parsed.get("foo"), "bar")
    }))

  it.effect("fromClientResponse turns empty client bodies into empty server streams", () =>
    Effect.gen(function*() {
      const request = HttpClientRequest.get("http://localhost:3000/empty")
      const clientResponse = HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))
      const response = HttpServerResponse.fromClientResponse(clientResponse)
      const roundTrip = HttpServerResponse.toClientResponse(response, { request })

      assert.strictEqual(response.status, 200)
      assert.strictEqual(yield* roundTrip.text, "")
    }))
})
