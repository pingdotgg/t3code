import * as Codegen from "effect/Codegen"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

const schema = Schema.Struct({
  a: Schema.String,
  b: Schema.optional(Schema.FiniteFromString),
  c: Schema.Array(Schema.String)
})

const document = SchemaRepresentation.toRepresentation(schema.ast)
const module = new Codegen.Module()
module.addSchemas({ Example: document.representation }, { references: document.references })
export const source = module.print()
