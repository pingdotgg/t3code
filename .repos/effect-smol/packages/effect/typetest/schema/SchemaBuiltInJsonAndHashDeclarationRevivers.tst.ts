import { Schema, type SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("Schema built-in JSON and hash collection declaration revivers", () => {
  it("exposes exact null payload reviver types", () => {
    const revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [
      Schema.JsonReviver,
      Schema.MutableJsonReviver,
      Schema.HashMapReviver,
      Schema.HashSetReviver
    ]

    expect(revivers).type.toBe<ReadonlyArray<SchemaRepresentation.AnyReviver>>()
    expect(Schema.JsonReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
    expect(Schema.MutableJsonReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
    expect(Schema.HashMapReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
    expect(Schema.HashSetReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
  })
})
