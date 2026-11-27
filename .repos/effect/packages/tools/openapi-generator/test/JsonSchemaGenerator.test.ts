import * as JsonSchemaGenerator from "@effect/openapi-generator/JsonSchemaGenerator"
import { assert, describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { withGeneratedModule } from "../../../effect/test/utils/generatedModule.ts"

describe("JsonSchemaGenerator", () => {
  it("schema & no definitions", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { type: "string" })
    const definitions = {}
    const result = generator.generate("openapi-3.1", definitions, false)
    expect(result).toBe(`export type A = string
export const A = Schema.String
`)
  })

  it("schema & definitions", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { $ref: "#/components/schemas/B" })
    const definitions = {
      B: { type: "string" }
    }
    const result = generator.generate("openapi-3.1", definitions, false)
    expect(result).toBe(`export type B = string
export const B = Schema.String.annotate({ "identifier": "B" })
export type A = B
export const A = B
`)
  })

  it("onEnter strips specified keys", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { type: "string", description: "desc", examples: ["ex"] })
    const definitions = {}
    const result = generator.generate("openapi-3.1", definitions, false, {
      onEnter: (js) => {
        const out = { ...js }
        delete out.examples
        return out
      }
    })
    expect(result).toBe(`export type A = string
export const A = Schema.String.annotate({ "description": "desc" })
`)
  })

  it("default preserves all annotations", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { type: "string", description: "desc", examples: ["ex"] })
    const definitions = {}
    const result = generator.generate("openapi-3.1", definitions, false)
    expect(result).toBe(`export type A = string
export const A = Schema.String.annotate({ "description": "desc", "examples": ["ex"] })
`)
  })

  it("omits examples with excess properties on closed objects while retaining valid examples", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
      examples: [{ value: "valid" }, { value: "invalid", extra: true }]
    })

    assert.strictEqual(
      generator.generate("openapi-3.1", {}, false),
      `export type A = { readonly "value"?: string }
export const A = Schema.Struct({ "value": Schema.optionalKey(Schema.String) }).annotate({ "examples": [{ "value": "valid" }] })
`
    )
  })

  const definitions = {
    A: {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"]
    },
    B: {
      type: "object",
      properties: { b: { type: "string" } },
      required: ["b"]
    }
  } as const

  const openA =
    `Schema.StructWithRest(Schema.Struct({ "a": Schema.String }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))])`
  const openB =
    `Schema.StructWithRest(Schema.Struct({ "b": Schema.String }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))])`

  for (
    const [keyword, expected] of [
      ["oneOf", `export const Choice = Schema.Union([${openA}, ${openB}], { mode: "oneOf" })`],
      ["anyOf", `export const Choice = Schema.Union([${openA}, ${openB}])`],
      [
        "allOf",
        `export const Choice = Schema.StructWithRest(Schema.Struct({ "a": Schema.String, "b": Schema.String }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))])`
      ]
    ] as const
  ) {
    it(`preserves omitted additionalProperties with ${keyword}`, () => {
      const generator = JsonSchemaGenerator.make()
      generator.addSchema("Choice", {
        type: "object",
        [keyword]: [
          { $ref: "#/components/schemas/A" },
          { $ref: "#/components/schemas/B" }
        ]
      })

      const result = generator.generate("openapi-3.1", definitions, false)

      expect(result).toContain(expected)
    })
  }

  it("honors explicit additionalProperties false with oneOf", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("Choice", {
      type: "object",
      additionalProperties: false,
      oneOf: [
        { $ref: "#/components/schemas/A" },
        { $ref: "#/components/schemas/B" }
      ]
    })

    const result = generator.generate("openapi-3.1", definitions, false)

    // The closed outer object forbids the properties required by both branches.
    expect(result).toContain("export const Choice = Schema.Never")
  })

  it("generateHttpApi emits explicit type and const declarations", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { type: "string" })
    generator.addSchema("B", {
      type: "object",
      properties: {
        id: {
          type: "string"
        }
      },
      required: ["id"],
      additionalProperties: false
    })

    const result = generator.generateHttpApi("openapi-3.1", {})

    expect(result).toContain(`export type A = string
export const A = Schema.String`)
    expect(result).toContain(`export type B = { readonly "id": string }
export const B = Schema.Struct({ "id": Schema.String })`)
    expect(result).not.toContain("Schema.Class<")
    expect(result).not.toContain("Schema.Opaque<")
  })

  it("recursive schema", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { $ref: "#/components/schemas/B" })
    const definitions = {
      B: {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "children": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/B"
            }
          }
        },
        "required": [
          "name",
          "children"
        ],
        "additionalProperties": false
      }
    }
    const result = generator.generate("openapi-3.1", definitions, false)
    expect(result).toBe(`export type B = { readonly "name": string, readonly "children": globalThis.ReadonlyArray<B> }
export const B = Schema.Struct({ "name": Schema.String, "children": Schema.Array(Schema.suspend((): Schema.Codec<B> => B)) }).annotate({ "identifier": "B" })
export type A = B
export const A = B
`)
  })

  it("initializes mutually recursive definitions", async () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { $ref: "#/components/schemas/ResourcesNetworkCard" })
    const definitions = {
      ResourcesNetworkCard: {
        type: "object",
        properties: {
          sriov: {
            $ref: "#/components/schemas/ResourcesNetworkCardSRIOV"
          }
        },
        additionalProperties: false
      },
      ResourcesNetworkCardSRIOV: {
        type: "object",
        properties: {
          vfs: {
            type: "array",
            items: {
              $ref: "#/components/schemas/ResourcesNetworkCard"
            }
          }
        },
        additionalProperties: false
      }
    }

    const result = generator.generate("openapi-3.1", definitions, false)
    await withGeneratedModule<{ A: Schema.Codec<unknown> }>(
      "import * as Schema from \"effect/Schema\"\n" + result,
      ({ A }) => {
        const value = { sriov: { vfs: [{ sriov: { vfs: [] } }] } }
        assert.deepStrictEqual(Schema.decodeUnknownSync(A)(value), value)
        assert.isFalse(Schema.is(A)({ sriov: { vfs: [1] } }))
      }
    )
  })

  it("initializes recursive definitions used by non-recursive schemas", async () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { $ref: "#/components/schemas/ErrorResponse" })
    const definitions = {
      InnerErrors: {
        type: "object",
        properties: {
          field: {
            type: "string"
          }
        },
        required: ["field"],
        additionalProperties: false
      },
      ErrorDetails: {
        oneOf: [
          {
            type: "object",
            additionalProperties: {
              $ref: "#/components/schemas/ErrorDetails"
            }
          },
          {
            $ref: "#/components/schemas/InnerErrors"
          }
        ]
      },
      ErrorResponse: {
        type: "object",
        properties: {
          errors: {
            $ref: "#/components/schemas/ErrorDetails"
          }
        },
        additionalProperties: false
      }
    }

    for (
      const source of [
        generator.generate("openapi-3.1", definitions, false),
        generator.generateHttpApi("openapi-3.1", definitions)
      ]
    ) {
      await withGeneratedModule<{ A: Schema.Codec<unknown> }>(
        "import * as Schema from \"effect/Schema\"\n" + source,
        ({ A }) => {
          const value = { errors: { path: { field: "a" } } }
          assert.deepStrictEqual(Schema.decodeUnknownSync(A)(value), value)
          assert.isFalse(Schema.is(A)({ errors: { path: { field: 1 } } }))
        }
      )
    }
  })
})
