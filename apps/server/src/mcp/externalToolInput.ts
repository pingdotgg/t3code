import * as Schema from "effect/Schema";
export const Input = Schema.Struct({
  target: Schema.String,
  operation: Schema.String,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
