import { assert, describe, it } from "@effect/vitest"
import { Schema, SchemaRepresentation } from "effect"

describe("SchemaRepresentation.fromSchemaMultiDocument", () => {
  it("preserves root order and lowers direct definitions", () => {
    assert.deepStrictEqual(
      SchemaRepresentation.fromSchemaMultiDocument({
        schemas: [Schema.String, Schema.Boolean],
        definitions: { Value: Schema.Number }
      }),
      {
        representations: [
          { _tag: "String", checks: [] },
          { _tag: "Boolean", checks: [] }
        ],
        references: { Value: { _tag: "Number", checks: [] } }
      }
    )
  })

  it("keeps distinct keys for definitions sharing the same schema", () => {
    assert.deepStrictEqual(
      SchemaRepresentation.fromSchemaMultiDocument({
        schemas: [Schema.String],
        definitions: { A: Schema.Number, B: Schema.Number }
      }),
      {
        representations: [{ _tag: "String", checks: [] }],
        references: {
          A: { _tag: "Reference", $ref: "B" },
          B: { _tag: "Number", checks: [] }
        }
      }
    )
  })

  it("preserves mutually recursive definitions", () => {
    const schemas = SchemaRepresentation.fromJsonSchemaMultiDocument({
      dialect: "draft-2020-12",
      schemas: [{ $ref: "#/$defs/A" }],
      definitions: {
        A: {
          type: "object",
          properties: { b: { $ref: "#/$defs/B" } },
          additionalProperties: false
        },
        B: {
          type: "object",
          properties: { a: { $ref: "#/$defs/A" } },
          additionalProperties: false
        }
      }
    })

    assert.deepStrictEqual(SchemaRepresentation.fromSchemaMultiDocument(schemas), {
      representations: [{ _tag: "Reference", $ref: "A" }],
      references: {
        A: {
          _tag: "Objects",
          propertySignatures: [{
            name: "b",
            type: { _tag: "Reference", $ref: "B" },
            isOptional: true,
            isMutable: false
          }],
          indexSignatures: [],
          checks: [],
          annotations: { identifier: "A" }
        },
        B: {
          _tag: "Objects",
          propertySignatures: [{
            name: "a",
            type: {
              _tag: "Suspend",
              checks: [],
              thunk: { _tag: "Reference", $ref: "A" }
            },
            isOptional: true,
            isMutable: false
          }],
          indexSignatures: [],
          checks: [],
          annotations: { identifier: "B" }
        }
      }
    })
  })

  it("allows an identified suspended external definition", () => {
    const Value = Schema.suspend(() => Schema.String).annotate({ identifier: "Value" })
    const document = SchemaRepresentation.fromSchemaMultiDocument({
      schemas: [Value],
      definitions: { Value }
    })

    assert.deepStrictEqual(document.representations[0], { _tag: "Reference", $ref: "Value" })
  })

  it("restores the identifier of an external definition", () => {
    const Value = Schema.Number
    const representation = SchemaRepresentation.fromSchemaMultiDocument({
      schemas: [Value],
      definitions: { Value }
    })
    const document = SchemaRepresentation.fromRepresentations(representation, { revivers: [] })

    assert.strictEqual(document.schemas[0], document.definitions.Value)
    assert.strictEqual(document.definitions.Value.ast._tag, "Number")
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(document.schemas[0].ast).representation, {
      _tag: "Reference",
      $ref: "Value"
    })
    assert.deepStrictEqual(Object.keys(SchemaRepresentation.fromSchemaMultiDocument(document).references), ["Value"])
  })

  it("rejects an identifier that collides with an external definition", () => {
    const Root = Schema.Number.annotate({ identifier: "Value" })

    assert.throws(
      () =>
        SchemaRepresentation.fromSchemaMultiDocument({
          schemas: [Root],
          definitions: { Value: Schema.String }
        }),
      /Duplicate identifier: "Value"/
    )
  })

  it("supports __proto__ as an external definition key", () => {
    const Value = Schema.Number
    const definitions: Record<string, Schema.Top> = {}
    Object.defineProperty(definitions, "__proto__", {
      value: Value,
      enumerable: true
    })

    const document = SchemaRepresentation.fromSchemaMultiDocument({
      schemas: [Value],
      definitions
    })

    assert.deepStrictEqual(document.representations[0], { _tag: "Reference", $ref: "__proto__" })
    assert.deepStrictEqual(Object.keys(document.references), ["__proto__"])
    assert.strictEqual(Object.getPrototypeOf(document.references), Object.prototype)
    assert.isTrue(Object.hasOwn(document.references, "__proto__"))
    assert.strictEqual(document.references["__proto__"]._tag, "Number")
  })
})
