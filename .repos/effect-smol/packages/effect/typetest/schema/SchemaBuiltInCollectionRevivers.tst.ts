import { Schema, type SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("Schema built-in collection revivers", () => {
  it("composes every collection check reviver without casts", () => {
    const revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [
      Schema.isMinSizeReviver,
      Schema.isMaxSizeReviver,
      Schema.isSizeBetweenReviver,
      Schema.isUniqueReviver
    ]

    expect(revivers).type.toBe<ReadonlyArray<SchemaRepresentation.AnyReviver>>()
    expect(Schema.isMinSizeReviver).type.toBe<
      SchemaRepresentation.FilterReviver<{ readonly minSize: number }>
    >()
    expect(Schema.isSizeBetweenReviver).type.toBe<
      SchemaRepresentation.FilterReviver<{
        readonly minimum: number
        readonly maximum: number
      }>
    >()
    expect(Schema.isUniqueReviver).type.toBe<SchemaRepresentation.FilterReviver<null>>()
  })
})
