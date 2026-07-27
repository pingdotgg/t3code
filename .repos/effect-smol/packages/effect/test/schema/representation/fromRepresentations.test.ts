import { assert, describe, it } from "@effect/vitest"
import { Schema, SchemaRepresentation } from "effect"

function decode(schema: Schema.Top, input: unknown): unknown {
  return Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(input)
}

describe("SchemaRepresentation.fromRepresentations", () => {
  it("preserves root order", () => {
    const document = SchemaRepresentation.fromRepresentations({
      representations: [
        { _tag: "String", checks: [] },
        { _tag: "Boolean", checks: [] },
        { _tag: "Number", checks: [] }
      ],
      references: {}
    }, { revivers: [] })

    assert.strictEqual(decode(document.schemas[0], "value"), "value")
    assert.strictEqual(decode(document.schemas[1], true), true)
    assert.strictEqual(decode(document.schemas[2], 1), 1)
  })

  it("revives unreachable definitions", () => {
    const document = SchemaRepresentation.fromRepresentations({
      representations: [{ _tag: "String", checks: [] }],
      references: { Unused: { _tag: "Number", checks: [] } }
    }, { revivers: [] })

    assert.deepStrictEqual(Object.keys(document.definitions), ["Unused"])
    assert.strictEqual(document.definitions.Unused.ast._tag, "Number")
    assert.strictEqual(decode(document.definitions.Unused, 1), 1)
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(document.definitions.Unused.ast).representation, {
      _tag: "Reference",
      $ref: "Unused"
    })
  })

  it("normalizes aliases while preserving the outer reference", () => {
    const document = SchemaRepresentation.fromRepresentations({
      representations: [{ _tag: "Reference", $ref: "Alias" }],
      references: {
        Alias: { _tag: "Reference", $ref: "Value" },
        Value: { _tag: "String", checks: [] }
      }
    }, { revivers: [] })

    assert.notStrictEqual(document.definitions.Value, document.definitions.Alias)
    assert.strictEqual(document.definitions.Value.ast._tag, "String")
    assert.strictEqual(document.definitions.Alias.ast._tag, "String")
    assert.strictEqual(document.schemas[0], document.definitions.Alias)
    assert.strictEqual(decode(document.schemas[0], "value"), "value")
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(document.schemas[0].ast).representation, {
      _tag: "Reference",
      $ref: "Alias"
    })
  })

  it("shares a resolved reference between roots", () => {
    const document = SchemaRepresentation.fromRepresentations({
      representations: [
        { _tag: "Reference", $ref: "Shared" },
        { _tag: "Reference", $ref: "Shared" }
      ],
      references: {
        Shared: { _tag: "Number", checks: [] }
      }
    }, { revivers: [] })

    assert.strictEqual(document.schemas[0], document.schemas[1])
    assert.strictEqual(document.schemas[0], document.definitions.Shared)
    assert.strictEqual(document.schemas[0].ast._tag, "Number")
  })

  it("revives recursive definitions", () => {
    const document = SchemaRepresentation.fromRepresentations({
      representations: [{ _tag: "Reference", $ref: "Recursive" }],
      references: {
        Recursive: {
          _tag: "Objects",
          checks: [],
          propertySignatures: [
            {
              name: "value",
              type: { _tag: "Number", checks: [] },
              isOptional: false,
              isMutable: false
            },
            {
              name: "next",
              type: { _tag: "Reference", $ref: "Recursive" },
              isOptional: true,
              isMutable: false
            }
          ],
          indexSignatures: []
        }
      }
    }, { revivers: [] })

    assert.strictEqual(document.schemas[0], document.definitions.Recursive)
    assert.strictEqual(document.definitions.Recursive.ast._tag, "Objects")
    if (document.definitions.Recursive.ast._tag === "Objects") {
      assert.strictEqual(document.definitions.Recursive.ast.propertySignatures[1].type._tag, "Suspend")
    }
    assert.deepStrictEqual(
      decode(document.schemas[0], {
        value: 1,
        next: { value: 2 }
      }),
      {
        value: 1,
        next: { value: 2 }
      }
    )
  })

  it("revives mutually recursive definitions with concrete roots", () => {
    const document = SchemaRepresentation.fromRepresentations({
      representations: [
        { _tag: "Reference", $ref: "A" },
        { _tag: "Reference", $ref: "B" }
      ],
      references: {
        A: {
          _tag: "Objects",
          checks: [],
          propertySignatures: [{
            name: "b",
            type: { _tag: "Reference", $ref: "B" },
            isOptional: true,
            isMutable: false
          }],
          indexSignatures: []
        },
        B: {
          _tag: "Objects",
          checks: [],
          propertySignatures: [{
            name: "a",
            type: { _tag: "Reference", $ref: "A" },
            isOptional: true,
            isMutable: false
          }],
          indexSignatures: []
        }
      }
    }, { revivers: [] })

    assert.strictEqual(document.definitions.A.ast._tag, "Objects")
    assert.strictEqual(document.definitions.B.ast._tag, "Objects")
    if (document.definitions.A.ast._tag === "Objects" && document.definitions.B.ast._tag === "Objects") {
      const b = document.definitions.A.ast.propertySignatures[0].type
      const a = document.definitions.B.ast.propertySignatures[0].type
      assert.isTrue(b._tag === "Suspend" || a._tag === "Suspend")
    }
    assert.deepStrictEqual(decode(document.schemas[0], { b: { a: {} } }), { b: { a: {} } })
    assert.deepStrictEqual(decode(document.schemas[1], { a: { b: {} } }), { a: { b: {} } })
  })
})
