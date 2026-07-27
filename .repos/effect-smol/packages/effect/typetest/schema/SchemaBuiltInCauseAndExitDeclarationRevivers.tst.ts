import { Schema, type SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("Schema built-in Cause and Exit declaration revivers", () => {
  it("exposes exact null payload reviver types", () => {
    const revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [
      Schema.CauseReasonReviver,
      Schema.CauseReviver,
      Schema.ExitReviver
    ]

    expect(revivers).type.toBe<ReadonlyArray<SchemaRepresentation.AnyReviver>>()
    expect(Schema.CauseReasonReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
    expect(Schema.CauseReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
    expect(Schema.ExitReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
  })
})
