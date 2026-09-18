import * as Schema from "effect/Schema"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const schema = Schema.Struct({
  a: Schema.String,
  b: Schema.optional(Schema.FiniteFromString),
  c: Schema.Array(Schema.String)
})

export const arbitrary = Arbitrary.schema(schema)
