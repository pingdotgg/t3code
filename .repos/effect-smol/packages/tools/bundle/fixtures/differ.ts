import * as Schema from "effect/Schema"

const schema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  price: Schema.Number
})

Schema.toDifferJsonPatch(schema)
