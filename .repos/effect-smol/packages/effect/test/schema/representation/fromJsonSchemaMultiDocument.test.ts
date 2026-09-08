import { assert } from "@effect/vitest"
import { Schema, type SchemaAST, SchemaRepresentation } from "effect"
import { describe, it } from "vitest"
import { deepStrictEqual, throws } from "../../utils/assert.ts"

function importAndLower(
  document: Parameters<typeof SchemaRepresentation.fromJsonSchemaMultiDocument>[0]
): SchemaRepresentation.MultiDocument {
  const schemas = SchemaRepresentation.fromJsonSchemaMultiDocument(document)
  return SchemaRepresentation.toRepresentations(
    schemas.map((schema) => schema.ast) as [SchemaAST.AST, ...Array<SchemaAST.AST>]
  )
}

describe("SchemaRepresentation.fromJsonSchemaMultiDocument", () => {
  it("propagates the pattern policy through reachable definitions", () => {
    const document: Parameters<typeof SchemaRepresentation.fromJsonSchemaMultiDocument>[0] = {
      dialect: "draft-2020-12" as const,
      schemas: [{ $ref: "#/$defs/A" }],
      definitions: {
        A: { type: "string", pattern: "^a+$" }
      }
    }

    throws(
      () => SchemaRepresentation.fromJsonSchemaMultiDocument(document),
      `Pattern encountered while patterns is set to "error"\n  at ["definitions"]["A"]["pattern"]`
    )

    const [schema] = SchemaRepresentation.fromJsonSchemaMultiDocument(document, { patterns: "apply" })
    assert.isTrue(Schema.is(schema)("aaa"))
    assert.isFalse(Schema.is(schema)("bbb"))
  })

  it("preserves an onEnter exception by identity", () => {
    const cause = new Error("boom")

    throws(
      () =>
        SchemaRepresentation.fromJsonSchemaMultiDocument({
          dialect: "draft-2020-12",
          schemas: [{ type: "string" }],
          definitions: {}
        }, {
          onEnter: () => {
            throw cause
          }
        }),
      (error: unknown) => {
        assert.strictEqual(error, cause)
        return undefined
      }
    )
  })

  it("preserves contentSchema as an annotation without traversing it", () => {
    const document = importAndLower({
      dialect: "draft-2020-12",
      schemas: [{
        type: "string",
        contentMediaType: "application/json",
        contentSchema: { $ref: "#/$defs/Payload" }
      }],
      definitions: {
        Payload: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false
        }
      }
    })

    const content = document.representations[0]
    assert.strictEqual(content._tag, "String")
    assert.deepStrictEqual(document.references, {})
    if (content._tag === "String") {
      assert.deepStrictEqual(content.annotations, {
        contentMediaType: "application/json",
        contentSchema: { $ref: "#/$defs/Payload" }
      })
    }
  })

  it("does not import unreachable definitions", () => {
    const schemas = SchemaRepresentation.fromJsonSchemaMultiDocument({
      dialect: "draft-2020-12",
      schemas: [{ type: "string" }],
      definitions: {
        Unused: { type: "number", description: "unused" }
      }
    }, {
      onEnter: (schema) => {
        if (schema.description === "unused") throw new Error("unreachable")
        return schema
      }
    })

    assert.strictEqual(schemas[0].ast._tag, "String")
  })

  it("preserves root order and shares definitions", () => {
    const document = importAndLower({
      dialect: "draft-2020-12",
      schemas: [
        { $ref: "#/$defs/A" },
        { $ref: "#/$defs/A", description: "second" },
        { type: "array", items: { $ref: "#/$defs/A" } },
        { $ref: "#/$defs/A", description: "fourth" }
      ],
      definitions: {
        A: { type: "string", minLength: 1 }
      }
    })

    deepStrictEqual(SchemaRepresentation.toJsonMultiDocument(document), {
      representations: [
        { _tag: "Reference", $ref: "A" },
        {
          _tag: "Suspend",
          checks: [],
          annotations: { description: "second" },
          thunk: { _tag: "Reference", $ref: "A" }
        },
        {
          _tag: "Arrays",
          elements: [],
          rest: [{ _tag: "Reference", $ref: "A" }],
          checks: []
        },
        {
          _tag: "Suspend",
          checks: [],
          annotations: { description: "fourth" },
          thunk: { _tag: "Reference", $ref: "A" }
        }
      ],
      references: {
        A: {
          _tag: "String",
          checks: [{
            _tag: "Filter",
            representation: {
              id: "effect/schema/isMinLength",
              payload: { minLength: 1 }
            },
            annotations: {
              identifier: "A",
              expected: "a value with a length of at least 1",
              "~structural": true,
              arbitrary: { constraint: { minLength: 1 } }
            },
            aborted: false
          }]
        }
      }
    })
  })

  it("resolves alias chains when combining a reference", () => {
    const document = importAndLower({
      dialect: "draft-2020-12",
      schemas: [{ $ref: "#/$defs/A", description: "root" }],
      definitions: {
        A: { $ref: "#/$defs/B" },
        B: { $ref: "#/$defs/C" },
        C: { type: "number" }
      }
    })

    deepStrictEqual(SchemaRepresentation.toJsonMultiDocument(document), {
      representations: [{
        _tag: "Suspend",
        checks: [],
        annotations: { description: "root" },
        thunk: { _tag: "Reference", $ref: "A" }
      }],
      references: {
        A: {
          _tag: "Number",
          checks: [{
            _tag: "Filter",
            representation: { id: "effect/schema/isFinite", payload: null },
            annotations: {
              identifier: "A",
              expected: "a finite number",
              arbitrary: { constraint: { noInfinity: true, noNaN: true } }
            },
            aborted: false
          }]
        }
      }
    })
  })

  it("tracks recursive definitions independently", () => {
    const document = importAndLower({
      dialect: "draft-2020-12",
      schemas: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
      definitions: {
        A: { $ref: "#/$defs/A" },
        B: { $ref: "#/$defs/B" }
      }
    })

    deepStrictEqual(SchemaRepresentation.toJsonMultiDocument(document), {
      representations: [
        { _tag: "Reference", $ref: "A" },
        { _tag: "Reference", $ref: "B" }
      ],
      references: {
        A: {
          _tag: "Suspend",
          annotations: { identifier: "A" },
          checks: [],
          thunk: { _tag: "Reference", $ref: "A" }
        },
        B: {
          _tag: "Suspend",
          annotations: { identifier: "B" },
          checks: [],
          thunk: { _tag: "Reference", $ref: "B" }
        }
      }
    })
  })

  it("throws when a reference that must be resolved is missing", () => {
    throws(
      () =>
        SchemaRepresentation.fromJsonSchemaMultiDocument({
          dialect: "draft-2020-12",
          schemas: [{ $ref: "#/$defs/Missing", description: "resolve" }],
          definitions: {}
        }),
      `Invalid reference "#/$defs/Missing"\n  at ["schemas"][0]["$ref"]`
    )
  })

  it("throws when resolving a circular alias chain", () => {
    throws(
      () =>
        SchemaRepresentation.fromJsonSchemaMultiDocument({
          dialect: "draft-2020-12",
          schemas: [{ $ref: "#/$defs/A", description: "resolve" }],
          definitions: {
            A: { $ref: "#/$defs/B" },
            B: { $ref: "#/$defs/A" }
          }
        }),
      "Invalid reference A\n  at [\"schemas\"][0][\"$ref\"]"
    )
  })
})
