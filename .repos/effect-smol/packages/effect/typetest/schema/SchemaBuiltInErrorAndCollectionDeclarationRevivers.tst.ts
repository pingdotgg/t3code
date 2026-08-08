import { Schema, type SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("Schema built-in Error and collection declaration revivers", () => {
  it("exposes exact payload and declaration reviver types", () => {
    const revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [
      Schema.ErrorReviver,
      Schema.ReadonlyMapReviver,
      Schema.ReadonlySetReviver
    ]

    expect(revivers).type.toBe<ReadonlyArray<SchemaRepresentation.AnyReviver>>()
    expect(Schema.ErrorReviver).type.toBe<
      SchemaRepresentation.DeclarationReviver<
        | null
        | {
          readonly includeStack?: true | undefined
          readonly excludeCause?: true | undefined
        }
      >
    >()
    expect(Schema.ReadonlyMapReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
    expect(Schema.ReadonlySetReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
  })
})
