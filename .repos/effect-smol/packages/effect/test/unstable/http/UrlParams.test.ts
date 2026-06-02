import { describe, it } from "@effect/vitest"
import { assertNone, assertSome } from "@effect/vitest/utils"
import { Schema } from "effect"
import { UrlParams } from "effect/unstable/http"
import { assertSuccess } from "../../utils/assert.ts"

describe("UrlParams", () => {
  describe("UrlParamsSchema", () => {
    it("round-trips ordered pairs with the serializer annotation", () => {
      const iso = Schema.toIso(UrlParams.UrlParamsSchema)
      const params = UrlParams.make([["a", "1"], ["b", "2"]])
      assertSuccess(iso.getResult(params), [["a", "1"], ["b", "2"]])
      assertSuccess(iso.replaceResult([["a", "1"], ["b", "3"]], params), UrlParams.make([["a", "1"], ["b", "3"]]))
    })
  })

  it("getFirst and getLast return Option", () => {
    const params = UrlParams.fromInput([[
      "foo",
      "a"
    ], [
      "foo",
      "b"
    ]])
    assertSome(UrlParams.getFirst(params, "foo"), "a")
    assertSome(UrlParams.getLast(params, "foo"), "b")
    assertNone(UrlParams.getFirst(params, "bar"))
    assertNone(UrlParams.getLast(params, "bar"))
  })
})
