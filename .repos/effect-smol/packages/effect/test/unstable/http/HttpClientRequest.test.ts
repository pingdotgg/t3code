import { describe, it } from "@effect/vitest"
import { assertNone, assertSome, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Effect, Stream } from "effect"
import * as Option from "effect/Option"
import { HttpClientRequest } from "effect/unstable/http"

describe("HttpClientRequest", () => {
  describe("appendUrl", () => {
    it("joins segments without slashes", () => {
      const request = HttpClientRequest.get("base").pipe(
        HttpClientRequest.appendUrl("users")
      )

      strictEqual(request.url, "base/users")
    })

    it("avoids double slashes", () => {
      const request = HttpClientRequest.get("base/").pipe(
        HttpClientRequest.appendUrl("/users")
      )

      strictEqual(request.url, "base/users")
    })

    it("preserves existing slash", () => {
      const request = HttpClientRequest.get("base/").pipe(
        HttpClientRequest.appendUrl("users")
      )

      strictEqual(request.url, "base/users")
    })

    it("preserves leading slash", () => {
      const request = HttpClientRequest.get("base").pipe(
        HttpClientRequest.appendUrl("/users")
      )

      strictEqual(request.url, "base/users")
    })

    it("no-ops on empty path", () => {
      const request = HttpClientRequest.get("base").pipe(
        HttpClientRequest.appendUrl("")
      )

      strictEqual(request.url, "base")
    })
  })

  describe("bodyFormDataRecord", () => {
    it("creates a form data body from a record", () => {
      const request = HttpClientRequest.post("/").pipe(
        HttpClientRequest.bodyFormDataRecord({
          a: "a",
          b: 1,
          c: true,
          d: null,
          e: undefined,
          f: ["x", 2, false, null, undefined]
        })
      )

      strictEqual(request.body._tag, "FormData")
      if (request.body._tag === "FormData") {
        strictEqual(request.body.formData.get("a"), "a")
        strictEqual(request.body.formData.get("b"), "1")
        strictEqual(request.body.formData.get("c"), "true")
        strictEqual(request.body.formData.has("d"), false)
        strictEqual(request.body.formData.has("e"), false)
        strictEqual(request.body.formData.getAll("f").join(","), "x,2,false")
      }
    })

    it("removes content headers when switching to form data", () => {
      const request = HttpClientRequest.post("/").pipe(
        HttpClientRequest.bodyText("hello"),
        HttpClientRequest.bodyFormDataRecord({ a: "a" })
      )

      strictEqual(request.headers["content-type"], undefined)
      strictEqual(request.headers["content-length"], undefined)
    })
  })

  describe("hash", () => {
    it("stores hash as Option", () => {
      const request = HttpClientRequest.get(new URL("http://example.com/path?x=1#section"))
      assertSome(request.hash, "section")
      const url = HttpClientRequest.toUrl(request)
      if (Option.isNone(url)) {
        throw new Error("Expected toUrl to return Some")
      }
      strictEqual(url.value.toString(), "http://example.com/path?x=1#section")
    })

    it("removes hash", () => {
      const request = HttpClientRequest.get("http://example.com").pipe(
        HttpClientRequest.setHash("section"),
        HttpClientRequest.removeHash
      )
      assertNone(request.hash)
    })

    it("returns none for invalid url", () => {
      const request = HttpClientRequest.get("http://example.com").pipe(
        HttpClientRequest.setUrl("http://[::1")
      )
      assertNone(HttpClientRequest.toUrl(request))
    })
  })

  describe("web conversions", () => {
    it.effect("fromWeb", () =>
      Effect.gen(function*() {
        const webRequest = new Request("http://localhost:3000/todos/1?a=1&a=2#top", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": "13",
            "x-test": "ok"
          },
          body: "{\"foo\":\"bar\"}"
        })
        const request = HttpClientRequest.fromWeb(webRequest)

        strictEqual(request.method, "POST")
        strictEqual(request.url, "http://localhost:3000/todos/1")
        assertSome(request.hash, "top")
        strictEqual(request.headers["content-type"], "application/json")
        strictEqual(request.headers["content-length"], "13")
        strictEqual(request.headers["x-test"], "ok")
        deepStrictEqual([...request.urlParams], [["a", "1"], ["a", "2"]])
        strictEqual(request.body._tag, "Raw")

        const webRequest2 = yield* HttpClientRequest.toWeb(request)
        strictEqual(yield* Effect.promise(() => webRequest2.text()), "{\"foo\":\"bar\"}")
      }))

    it.effect("toWeb stream body", () =>
      Effect.gen(function*() {
        const body = new Uint8Array([104, 101, 108, 108, 111])
        const request = HttpClientRequest.post("http://localhost:3000/stream").pipe(
          HttpClientRequest.bodyStream(Stream.succeed(body), {
            contentType: "text/plain",
            contentLength: body.length
          })
        )
        const webRequest = yield* HttpClientRequest.toWeb(request)

        strictEqual(webRequest.method, "POST")
        strictEqual(webRequest.url, "http://localhost:3000/stream")
        strictEqual(yield* Effect.promise(() => webRequest.text()), "hello")
      }))

    it("toWebResult returns failure for invalid url", () => {
      const request = HttpClientRequest.get("http://localhost").pipe(
        HttpClientRequest.setUrl("http://[::1")
      )
      const result = HttpClientRequest.toWebResult(request)

      strictEqual(result._tag, "Failure")
    })
  })
})
