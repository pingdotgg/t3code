import { Schema, type SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("Schema built-in object revivers", () => {
  it("composes every object check reviver without casts", () => {
    const revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [
      Schema.isMinPropertiesReviver,
      Schema.isMaxPropertiesReviver,
      Schema.isPropertiesLengthBetweenReviver,
      Schema.isPropertyNamesReviver
    ]

    expect(revivers).type.toBe<ReadonlyArray<SchemaRepresentation.AnyReviver>>()
    expect(Schema.isMinPropertiesReviver).type.toBe<
      SchemaRepresentation.FilterReviver<{ readonly minProperties: number }>
    >()
    expect(Schema.isPropertiesLengthBetweenReviver).type.toBe<
      SchemaRepresentation.FilterReviver<{
        readonly minimum: number
        readonly maximum: number
      }>
    >()
    expect(Schema.isPropertyNamesReviver).type.toBe<SchemaRepresentation.FilterReviver<null>>()
  })
})
