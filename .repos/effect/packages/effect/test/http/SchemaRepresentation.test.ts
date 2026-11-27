import { assert, describe, it } from "@effect/vitest"
import { Schema, SchemaRepresentation } from "effect"
import * as Multipart from "effect/http/Multipart"
import { assertSchemas, makeModule } from "../utils/schemaCodegen.ts"

describe("HTTP schema representations", () => {
  it("generates code for declaration schemas", () => {
    const document = SchemaRepresentation.toRepresentations([
      Schema.Headers.ast,
      Schema.Cookies.ast,
      Schema.Cookie.ast,
      Schema.UrlParams.ast,
      Multipart.PersistedFileSchema.ast
    ])

    assert.deepStrictEqual(
      document.representations.map((representation) =>
        representation._tag === "Declaration" ? representation.representation : undefined
      ),
      [
        { id: "effect/http/Headers", payload: null },
        { id: "effect/http/Cookies", payload: null },
        { id: "effect/http/Cookie", payload: null },
        { id: "effect/http/UrlParams", payload: null },
        { id: "effect/http/PersistedFile", payload: null }
      ]
    )

    assertSchemas(makeModule(document), {
      TestRoot0: { runtime: `Schema.Headers.annotate({ "expected": "Headers" })`, Type: "Headers.Headers" },
      TestRoot1: { runtime: `Schema.Cookies.annotate({ "expected": "Cookies" })`, Type: "Cookies.Cookies" },
      TestRoot2: { runtime: `Schema.Cookie.annotate({ "expected": "Cookie" })`, Type: "Cookies.Cookie" },
      TestRoot3: { runtime: `Schema.UrlParams.annotate({ "expected": "UrlParams" })`, Type: "UrlParams.UrlParams" },
      TestRoot4: {
        runtime: `Multipart.PersistedFileSchema.annotate({ "expected": "PersistedFile" })`,
        Type: "Multipart.PersistedFile"
      }
    }, [
      `import * as Schema from "effect/Schema"`,
      `import * as Headers from "effect/http/Headers"`,
      `import * as Cookies from "effect/http/Cookies"`,
      `import * as UrlParams from "effect/http/UrlParams"`,
      `import * as Multipart from "effect/http/Multipart"`
    ])
  })
})
