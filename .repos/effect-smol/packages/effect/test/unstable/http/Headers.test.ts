import { describe, it } from "@effect/vitest"
import { assertNone, assertSome, deepStrictEqual, doesNotThrow, strictEqual } from "@effect/vitest/utils"
import { Schema } from "effect"
import { Headers } from "effect/unstable/http"
import { assertSuccess } from "../../utils/assert.ts"

describe("Headers", () => {
  describe("HeadersSchema", () => {
    it("serializer annotation", () => {
      const _Accept = Schema.toIso(Headers.HeadersSchema).at("Accept")
      const headers = Headers.fromRecordUnsafe({
        "Accept": "application/json, text/plain, */*",
        "Cache-Control": "no-cache"
      })
      assertSuccess(_Accept.getResult(headers), "application/json, text/plain, */*")
      assertSuccess(
        _Accept.replaceResult("application/json", headers),
        Headers.fromRecordUnsafe({
          "accept": "application/json",
          "cache-control": "no-cache"
        })
      )
    })
  })

  it("does not expose inspectable prototype methods during for..in iteration", () => {
    const headers = Headers.fromInput({ foo: "bar" })
    const keys: Array<string> = []

    for (const key in headers) {
      keys.push(key)
    }

    deepStrictEqual(keys, ["foo"])
  })

  it("remove", () => {
    const headers = Headers.fromInput({ foo: "bar", baz: "qux", hello: "world" })
    const result = Headers.remove(headers, "baz")
    deepStrictEqual({ ...result }, { foo: "bar", hello: "world" })
  })

  it("removeMany deletes multiple headers", () => {
    const headers = Headers.fromInput({ foo: "bar", baz: "qux", hello: "world" })
    const result = Headers.removeMany(headers, ["baz", "hello"])
    deepStrictEqual({ ...result }, { foo: "bar" })
  })

  it("removeMany normalizes keys to lowercase", () => {
    const headers = Headers.fromInput({ "Content-Type": "text/plain", "X-Custom": "value", keep: "me" })
    const result = Headers.removeMany(headers, ["Content-Type", "X-CUSTOM"])
    deepStrictEqual({ ...result }, { keep: "me" })
  })

  it("works with for..in based headers polyfills", () => {
    const effectHeaders = Headers.fromInput({ foo: "bar" })
    const nativeHeaders = new globalThis.Headers()

    doesNotThrow(() => {
      for (const key in effectHeaders) {
        nativeHeaders.append(key, effectHeaders[key])
      }
    })

    strictEqual(nativeHeaders.get("foo"), "bar")
  })

  it("get returns Option", () => {
    const headers = Headers.fromInput({ foo: "bar" })
    assertSome(Headers.get(headers, "foo"), "bar")
    assertNone(Headers.get(headers, "missing"))
  })
})
