import { assert, describe, it } from "@effect/vitest"
import { Schema, SchemaRepresentation } from "effect"
import { throws } from "../../utils/assert.ts"

function expectError(thunk: () => void, expected: string | Error): void {
  if (typeof expected === "string") {
    throws(thunk, expected)
  } else {
    throws(thunk, (error: unknown) => {
      assert.strictEqual(error, expected)
      return undefined
    })
  }
}

const StringRepresentation: SchemaRepresentation.Representation = {
  _tag: "String",
  checks: []
}

describe("SchemaRepresentation.toJsonSchemaMultiDocument", () => {
  it("should handle multiple schemas", () => {
    const A = Schema.String.annotate({ identifier: "A", description: "a" })
    const B = Schema.String.annotate({ identifier: "B", description: "b" })
    const C = Schema.Tuple([A, B])
    const multiDocument = SchemaRepresentation.toRepresentations([A.ast, B.ast, C.ast])
    const jsonMultiDocument = SchemaRepresentation.toJsonSchemaMultiDocument(multiDocument)
    assert.deepStrictEqual(jsonMultiDocument, {
      dialect: "draft-2020-12",
      schemas: [
        { "$ref": "#/$defs/A" },
        { "$ref": "#/$defs/B" },
        {
          "type": "array",
          "prefixItems": [
            { "$ref": "#/$defs/A" },
            { "$ref": "#/$defs/B" }
          ],
          "minItems": 2,
          "maxItems": 2
        }
      ],
      definitions: {
        A: {
          "type": "string",
          "description": "a"
        },
        B: {
          "type": "string",
          "description": "b"
        }
      }
    })
  })
  it("emits standard annotations and oneOf unions", () => {
    const output = SchemaRepresentation.toJsonSchemaMultiDocument({
      representations: [
        {
          _tag: "String",
          annotations: {
            format: "email",
            contentEncoding: "base64",
            contentMediaType: "application/json",
            contentSchema: { type: "string" }
          },
          checks: []
        },
        {
          _tag: "Union",
          types: [StringRepresentation, { _tag: "Boolean", checks: [] }],
          mode: "oneOf",
          checks: []
        }
      ],
      references: {}
    })

    assert.deepStrictEqual(output.schemas, [
      {
        type: "string",
        format: "email",
        contentEncoding: "base64",
        contentMediaType: "application/json",
        contentSchema: { type: "string" }
      },
      { oneOf: [{ type: "string" }, { type: "boolean" }] }
    ])
  })

  it("uses group overrides without visiting children and otherwise falls back to allOf", () => {
    let visits = 0
    const child: SchemaRepresentation.Filter = {
      _tag: "Filter",
      aborted: false,
      annotations: {
        toJsonSchema: () => {
          visits++
          return { minLength: 1 }
        }
      }
    }
    const override: SchemaRepresentation.FilterGroup = {
      _tag: "FilterGroup",
      checks: [child],
      annotations: {
        description: "override",
        toJsonSchema: () => ({ format: "custom" })
      }
    }
    const fallback: SchemaRepresentation.FilterGroup = {
      _tag: "FilterGroup",
      checks: [child, { _tag: "Filter", aborted: false }],
      annotations: { description: "fallback" }
    }
    const document: SchemaRepresentation.MultiDocument = {
      representations: [
        { _tag: "String", checks: [override] },
        { _tag: "String", checks: [fallback] }
      ],
      references: {}
    }

    const output = SchemaRepresentation.toJsonSchemaMultiDocument(document)
    assert.strictEqual(visits, 1)
    assert.deepStrictEqual(output.schemas, [
      {
        type: "string",
        allOf: [{ format: "custom", description: "override" }]
      },
      {
        type: "string",
        allOf: [{ allOf: [{ minLength: 1 }], description: "fallback" }]
      }
    ])
  })

  it("resolves referenced index-signature parameters and stops cycles", () => {
    const record = (
      parameter: SchemaRepresentation.Representation
    ): SchemaRepresentation.Representation => ({
      _tag: "Objects",
      propertySignatures: [],
      indexSignatures: [{ parameter, type: StringRepresentation }],
      checks: []
    })
    const pattern = SchemaRepresentation.toRepresentation(
      Schema.String.check(Schema.isPattern(/^a/)).ast
    ).representation
    const output = SchemaRepresentation.toJsonSchemaMultiDocument({
      representations: [
        record({ _tag: "Reference", $ref: "Pattern" }),
        record({ _tag: "Reference", $ref: "Cycle" })
      ],
      references: {
        Pattern: pattern,
        Cycle: { _tag: "Reference", $ref: "Cycle" }
      }
    })

    assert.deepStrictEqual(output.schemas, [
      {
        type: "object",
        patternProperties: { "^a": { type: "string" } }
      },
      {
        type: "object",
        additionalProperties: { type: "string" }
      }
    ])

    expectError(
      () =>
        SchemaRepresentation.toJsonSchemaDocument({
          representation: record({ _tag: "Reference", $ref: "Missing" }),
          references: {}
        }),
      `Invalid reference Missing\n  at ["representation"]["indexSignatures"][0]["parameter"]["$ref"]`
    )
  })
})
