import { Schema, type SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("Schema built-in revivers", () => {
  it("exports the isPattern and Option revivers with concrete payload types", () => {
    expect(Schema.isPatternReviver).type.toBe<
      SchemaRepresentation.FilterReviver<{ readonly source: string; readonly flags: string }>
    >()
    expect(Schema.OptionReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()

    const revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [
      Schema.isPatternReviver,
      Schema.OptionReviver
    ]
    expect(revivers).type.toBe<ReadonlyArray<SchemaRepresentation.AnyReviver>>()
  })
})
