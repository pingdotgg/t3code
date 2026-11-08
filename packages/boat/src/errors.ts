import * as Schema from "effect/Schema";

export class BoatApiError extends Schema.TaggedError<BoatApiError>()("BoatApiError", {
  status: Schema.Number,
  sandboxId: Schema.optionalKey(Schema.String),
  reason: Schema.String,
  detail: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
  rateLimit: Schema.optionalKey(
    Schema.Struct({
      scope: Schema.Literals(["paced", "capped", "capacity"]),
      window: Schema.optionalKey(Schema.Literals(["minute", "hour", "day"])),
      waitMs: Schema.optionalKey(Schema.Number),
    }),
  ),
}) {
  override get message(): string {
    return this.reason;
  }
}
