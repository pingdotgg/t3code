import { Schema, type SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("Schema built-in Result and Redacted declaration revivers", () => {
  it("exposes exact payload and declaration reviver types", () => {
    const revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [
      Schema.ResultReviver,
      Schema.RedactedReviver
    ]

    expect(revivers).type.toBe<ReadonlyArray<SchemaRepresentation.AnyReviver>>()
    expect(Schema.ResultReviver).type.toBe<SchemaRepresentation.DeclarationReviver<null>>()
    expect(Schema.RedactedReviver).type.toBe<
      SchemaRepresentation.DeclarationReviver<
        | null
        | {
          readonly label?: string | undefined
          readonly disallowJsonEncode?: true | undefined
        }
      >
    >()
  })
})
