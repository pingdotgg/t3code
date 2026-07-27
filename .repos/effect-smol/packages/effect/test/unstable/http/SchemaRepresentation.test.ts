import { assert, describe, it } from "@effect/vitest"
import { SchemaRepresentation } from "effect"
import { Cookies, Headers, UrlParams } from "effect/unstable/http"

describe("HTTP schema representations", () => {
  it("generates code for declaration schemas", () => {
    const document = SchemaRepresentation.toRepresentations([
      Headers.HeadersSchema.ast,
      Cookies.CookiesSchema.ast,
      Cookies.CookieSchema.ast,
      UrlParams.UrlParamsSchema.ast
    ])

    assert.deepStrictEqual(
      document.representations.map((representation) =>
        representation._tag === "Declaration" ? representation.representation : undefined
      ),
      [
        { id: "effect/http/Headers", payload: null },
        { id: "effect/http/Cookies", payload: null },
        { id: "effect/http/Cookie", payload: null },
        { id: "effect/http/UrlParams", payload: null }
      ]
    )

    const output = SchemaRepresentation.toCodeDocument(document)

    assert.deepStrictEqual(output.codes, [
      { runtime: `Headers.HeadersSchema.annotate({ "expected": "Headers" })`, Type: "Headers.Headers" },
      { runtime: `Cookies.CookiesSchema.annotate({ "expected": "Cookies" })`, Type: "Cookies.Cookies" },
      { runtime: `Cookies.CookieSchema.annotate({ "expected": "Cookie" })`, Type: "Cookies.Cookie" },
      { runtime: `UrlParams.UrlParamsSchema.annotate({ "expected": "UrlParams" })`, Type: "UrlParams.UrlParams" }
    ])
    assert.deepStrictEqual(output.artifacts, [
      {
        _tag: "Import",
        importDeclaration: `import * as Headers from "effect/unstable/http/Headers"`
      },
      {
        _tag: "Import",
        importDeclaration: `import * as Cookies from "effect/unstable/http/Cookies"`
      },
      {
        _tag: "Import",
        importDeclaration: `import * as UrlParams from "effect/unstable/http/UrlParams"`
      }
    ])
  })
})
