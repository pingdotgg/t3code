import { Schema, type SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("Schema built-in string revivers", () => {
  it("composes every string check reviver without casts", () => {
    const revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [
      Schema.isStringFiniteReviver,
      Schema.isStringBigIntReviver,
      Schema.isStringSymbolReviver,
      Schema.isMinLengthReviver,
      Schema.isMaxLengthReviver,
      Schema.isLengthBetweenReviver,
      Schema.isPatternReviver,
      Schema.isTrimmedReviver,
      Schema.isUUIDReviver,
      Schema.isGUIDReviver,
      Schema.isULIDReviver,
      Schema.isBase64Reviver,
      Schema.isBase64UrlReviver,
      Schema.isStartsWithReviver,
      Schema.isEndsWithReviver,
      Schema.isIncludesReviver,
      Schema.isUppercasedReviver,
      Schema.isLowercasedReviver,
      Schema.isCapitalizedReviver,
      Schema.isUncapitalizedReviver
    ]

    expect(revivers).type.toBe<ReadonlyArray<SchemaRepresentation.AnyReviver>>()
    expect(Schema.isMinLengthReviver).type.toBe<
      SchemaRepresentation.FilterReviver<{ readonly minLength: number }>
    >()
    expect(Schema.isLengthBetweenReviver).type.toBe<
      SchemaRepresentation.FilterReviver<{ readonly minimum: number; readonly maximum: number }>
    >()
    expect(Schema.isUUIDReviver).type.toBe<
      SchemaRepresentation.FilterReviver<{
        readonly version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | null
      }>
    >()
  })
})
