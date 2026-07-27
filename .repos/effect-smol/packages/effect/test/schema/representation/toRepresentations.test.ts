import { assert, describe, it } from "@effect/vitest"
import { Schema, SchemaRepresentation } from "effect"

describe("SchemaRepresentation.toRepresentations", () => {
  it("preserves root order", () => {
    const document = SchemaRepresentation.toRepresentations([
      Schema.String.ast,
      Schema.Number.ast,
      Schema.Boolean.ast
    ])

    assert.deepStrictEqual(document, {
      representations: [
        { _tag: "String", checks: [] },
        { _tag: "Number", checks: [] },
        { _tag: "Boolean", checks: [] }
      ],
      references: {}
    })
  })

  it("shares a named reference between roots", () => {
    const shared = Schema.String.annotate({ identifier: "Shared" })
    const document = SchemaRepresentation.toRepresentations([shared.ast, shared.ast])

    assert.deepStrictEqual(document, {
      representations: [
        { _tag: "Reference", $ref: "Shared" },
        { _tag: "Reference", $ref: "Shared" }
      ],
      references: {
        Shared: {
          _tag: "String",
          annotations: { identifier: "Shared" },
          checks: []
        }
      }
    })
  })

  it("does not conflate an identified schema with a checked derivative", () => {
    const base = Schema.String.annotate({ identifier: "Text" })
    const refined = base.pipe(Schema.check(Schema.isMinLength(1)))
    const forward = SchemaRepresentation.toRepresentations([base.ast, refined.ast])
    const reversed = SchemaRepresentation.toRepresentations([refined.ast, base.ast])

    assert.deepStrictEqual(forward.representations[0], { _tag: "Reference", $ref: "Text" })
    assert.strictEqual(forward.representations[1]._tag, "String")
    if (forward.representations[1]._tag === "String") {
      assert.strictEqual(forward.representations[1].checks.length, 1)
    }
    assert.strictEqual(reversed.representations[0]._tag, "String")
    if (reversed.representations[0]._tag === "String") {
      assert.strictEqual(reversed.representations[0].checks.length, 1)
    }
    assert.deepStrictEqual(reversed.representations[1], { _tag: "Reference", $ref: "Text" })
    assert.deepStrictEqual(forward.references, {
      Text: {
        _tag: "String",
        annotations: { identifier: "Text" },
        checks: []
      }
    })
    assert.deepStrictEqual(reversed.references, forward.references)
  })

  it("shares an anonymous non-trivial schema between roots", () => {
    const shared = Schema.Struct({ value: Schema.String })
    const document = SchemaRepresentation.toRepresentations([shared.ast, shared.ast])

    assert.deepStrictEqual(document, {
      representations: [
        { _tag: "Reference", $ref: "Objects_" },
        { _tag: "Reference", $ref: "Objects_" }
      ],
      references: {
        Objects_: {
          _tag: "Objects",
          propertySignatures: [{
            name: "value",
            type: { _tag: "String", checks: [] },
            isOptional: false,
            isMutable: false
          }],
          indexSignatures: [],
          checks: []
        }
      }
    })
  })

  it("rejects different schemas with the same identifier", () => {
    const first = Schema.String.annotate({ identifier: "Value", description: "first" })
    const second = Schema.Number.annotate({ identifier: "Value", description: "second" })

    assert.throws(
      () => SchemaRepresentation.toRepresentations([first.ast, second.ast]),
      /Duplicate identifier: "Value"/
    )
  })

  it("rejects equivalent schemas with the same identifier", () => {
    const first = Schema.String.annotate({ identifier: "Value" })
    const second = Schema.String.annotate({ identifier: "Value" })

    assert.throws(
      () => SchemaRepresentation.toRepresentations([first.ast, second.ast]),
      /Duplicate identifier: "Value"/
    )
  })

  it("suffixes fallback identifiers without displacing an explicit identifier", () => {
    const first = Schema.String.annotate({ "~identifier": "Person" })
    const second = Schema.Number.annotate({ "~identifier": "Person" })
    const explicit = Schema.Boolean.annotate({ identifier: "PersonJsonEncoding" })

    assert.deepStrictEqual(
      SchemaRepresentation.toRepresentations([first.ast, second.ast, explicit.ast]),
      {
        representations: [
          { _tag: "Reference", $ref: "PersonJsonEncoding1" },
          { _tag: "Reference", $ref: "PersonJsonEncoding2" },
          { _tag: "Reference", $ref: "PersonJsonEncoding" }
        ],
        references: {
          PersonJsonEncoding1: {
            _tag: "String",
            annotations: { "~identifier": "Person" },
            checks: []
          },
          PersonJsonEncoding2: {
            _tag: "Number",
            annotations: { "~identifier": "Person" },
            checks: []
          },
          PersonJsonEncoding: {
            _tag: "Boolean",
            annotations: { identifier: "PersonJsonEncoding" },
            checks: []
          }
        }
      }
    )
  })
})
