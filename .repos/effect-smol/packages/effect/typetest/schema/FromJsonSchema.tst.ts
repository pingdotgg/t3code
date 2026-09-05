import { type JsonSchema, type Schema, SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("JSON Schema importer", () => {
  it("exposes exact synchronous signatures", () => {
    const fromDocument: (
      document: JsonSchema.Document<"draft-2020-12">,
      options?: SchemaRepresentation.FromJsonSchemaOptions
    ) => Schema.Top = SchemaRepresentation.fromJsonSchemaDocument
    const fromMultiDocument: (
      document: JsonSchema.MultiDocument<"draft-2020-12">,
      options?: SchemaRepresentation.FromJsonSchemaOptions
    ) => SchemaRepresentation.SchemaMultiDocument = SchemaRepresentation.fromJsonSchemaMultiDocument
    const fromSchemaMultiDocument: (
      document: SchemaRepresentation.SchemaMultiDocument
    ) => SchemaRepresentation.MultiDocument = SchemaRepresentation.fromSchemaMultiDocument
    expect(fromDocument).type.toBe<
      (
        document: JsonSchema.Document<"draft-2020-12">,
        options?: SchemaRepresentation.FromJsonSchemaOptions
      ) => Schema.Top
    >()
    expect(fromMultiDocument).type.toBe<
      (
        document: JsonSchema.MultiDocument<"draft-2020-12">,
        options?: SchemaRepresentation.FromJsonSchemaOptions
      ) => SchemaRepresentation.SchemaMultiDocument
    >()
    expect(fromSchemaMultiDocument).type.toBe<
      (document: SchemaRepresentation.SchemaMultiDocument) => SchemaRepresentation.MultiDocument
    >()
  })

  it("keeps onEnter limited to JSON Schema nodes", () => {
    const options: SchemaRepresentation.FromJsonSchemaOptions = {
      onEnter: (schema) => ({ ...schema, description: "entered" })
    }

    expect(options.onEnter).type.toBe<
      ((schema: JsonSchema.JsonSchema) => JsonSchema.JsonSchema) | undefined
    >()
  })
})
