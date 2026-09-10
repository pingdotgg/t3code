import * as Schema from "effect/Schema"
import * as SchemaBinary from "effect/unstable/encoding/SchemaBinary"

const schema = Schema.Struct({
  a: Schema.String,
  b: Schema.optional(Schema.FiniteFromString),
  c: Schema.Array(Schema.String)
})

export const codec = SchemaBinary.toCodec(schema)
