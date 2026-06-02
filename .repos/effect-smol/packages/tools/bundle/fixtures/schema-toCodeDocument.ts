import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

const schema = Schema.Struct({
  a: Schema.String,
  b: Schema.optional(Schema.FiniteFromString),
  c: Schema.Array(Schema.String)
})

const representation = Schema.toRepresentation(schema)

SchemaRepresentation.toCodeDocument(SchemaRepresentation.toMultiDocument(representation))
