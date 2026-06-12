import { describe, it } from "@effect/vitest"
import { Effect, identity, Schema, Stream, Unify } from "effect"
import { Multipart } from "effect/unstable/http"
import { deepStrictEqual } from "node:assert"

describe("Multipart", () => {
  it.effect("parses fields and streams file content", () =>
    Effect.gen(function*() {
      const data = new globalThis.FormData()
      data.append("foo", "bar")
      data.append("test", "ing")
      data.append("file", new globalThis.File(["A".repeat(1024 * 1024)], "foo.txt", { type: "text/plain" }))
      const response = new Response(data)

      const parts = yield* Stream.fromReadableStream({
        evaluate: () => response.body!,
        onError: identity
      }).pipe(
        Stream.pipeThroughChannel(Multipart.makeChannel(Object.fromEntries(response.headers))),
        Stream.mapEffect((part) => {
          return Unify.unify(
            part._tag === "File" ?
              Effect.zip(
                Effect.succeed(part.name),
                Stream.mkString(Stream.decodeText(part.content))
              ) :
              Effect.succeed([part.key, part.value] as const)
          )
        }),
        Stream.runCollect
      )

      deepStrictEqual(parts, [
        ["foo", "bar"],
        ["test", "ing"],
        ["foo.txt", "A".repeat(1024 * 1024)]
      ])
    }))

  describe("FileSchema", () => {
    it("toJsonSchema", () => {
      const document = Schema.toJsonSchemaDocument(Multipart.PersistedFileSchema)
      deepStrictEqual(document, {
        dialect: "draft-2020-12",
        schema: {
          "type": "object",
          "properties": {
            "key": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "contentType": {
              "type": "string",
              "contentEncoding": "binary"
            },
            "path": {
              "type": "string"
            }
          },
          "required": ["key", "name", "contentType", "path"],
          "additionalProperties": false
        },
        definitions: {}
      })
    })
  })
})
