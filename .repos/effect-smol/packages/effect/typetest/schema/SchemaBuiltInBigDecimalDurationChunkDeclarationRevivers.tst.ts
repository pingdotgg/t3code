import { Schema, type SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("Schema built-in BigDecimal, Duration and Chunk declaration revivers", () => {
  it("composes every declaration reviver without casts", () => {
    const revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [
      Schema.BigDecimalReviver,
      Schema.DurationReviver,
      Schema.ChunkReviver
    ]

    expect(revivers).type.toBe<ReadonlyArray<SchemaRepresentation.AnyReviver>>()
    expect(Schema.BigDecimalReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
    expect(Schema.DurationReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
    expect(Schema.ChunkReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
  })
})
