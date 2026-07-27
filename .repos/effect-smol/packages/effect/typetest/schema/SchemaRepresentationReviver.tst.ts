import { Schema, SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("SchemaRepresentation revivers", () => {
  it("infers payload types from reviver constructors", () => {
    const declaration = SchemaRepresentation.makeDeclarationReviver(
      "acme/schema/Box",
      Schema.Struct({ label: Schema.String }),
      ({ payload }) => {
        expect(payload).type.toBe<{ readonly label: string }>()
        return Schema.String
      }
    )
    expect(declaration).type.toBe<SchemaRepresentation.DeclarationReviver<{ readonly label: string }>>()

    const filter = SchemaRepresentation.makeFilterReviver(
      "acme/schema/minLength",
      Schema.Struct({ minimum: Schema.Number }),
      ({ annotations, payload }) => {
        expect(payload).type.toBe<{ readonly minimum: number }>()
        return Schema.isMinLength(payload.minimum, annotations)
      }
    )
    expect(filter).type.toBe<SchemaRepresentation.FilterReviver<{ readonly minimum: number }>>()

    const filterGroup = SchemaRepresentation.makeFilterGroupReviver(
      "acme/schema/nonEmpty",
      Schema.Null,
      ({ annotations, payload }) => {
        expect(payload).type.toBe<null>()
        return Schema.makeFilterGroup([Schema.isMinLength(1)], annotations)
      }
    )
    expect(filterGroup).type.toBe<SchemaRepresentation.FilterGroupReviver<null>>()
  })

  it("accepts concrete payload revivers at the erased collection boundary", () => {
    const reviver: SchemaRepresentation.FilterReviver<{ readonly source: string }> = {
      id: "acme/schema/isPattern",
      payloadSchema: Schema.Struct({ source: Schema.String }),
      revive: ({ payload, annotations }) => Schema.isPattern(new RegExp(payload.source), annotations)
    }
    const revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [reviver]

    expect(revivers).type.toBe<ReadonlyArray<SchemaRepresentation.AnyReviver>>()
  })

  it("separates JSON decoding from schema revival", () => {
    expect(SchemaRepresentation.fromJson).type.toBe<
      (input: Schema.Json) => SchemaRepresentation.Document
    >()
    expect(SchemaRepresentation.fromJsonMultiDocument).type.toBe<
      (input: Schema.Json) => SchemaRepresentation.MultiDocument
    >()
    expect(SchemaRepresentation.fromRepresentation).type.toBe<
      (
        document: SchemaRepresentation.Document,
        options: { readonly revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> }
      ) => Schema.Top
    >()
    expect(SchemaRepresentation.fromRepresentations).type.toBe<
      (
        document: SchemaRepresentation.MultiDocument,
        options: { readonly revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> }
      ) => SchemaRepresentation.SchemaMultiDocument
    >()

    const document = SchemaRepresentation.fromJson({ representation: { _tag: "String", checks: [] }, references: {} })
    // @ts-expect-error Expected 2 arguments, but got 1.
    SchemaRepresentation.fromRepresentation(document)
    // @ts-expect-error Expected 2 arguments, but got 1.
    SchemaRepresentation.fromRepresentations({
      representations: [{ _tag: "String", checks: [] }],
      references: {}
    })
  })
})
