import * as Schema from "effect/Schema";

/** Failures from Kilo Cloud customer endpoints. None of them proves that billing stopped. */
export class KiloCloudError extends Schema.TaggedError<KiloCloudError>()("KiloCloudError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "rejected",
    "not_found",
    "admission_unknown",
    "invalid_response",
    "wrong_owner",
    "unsupported",
    "recovery_incomplete",
    "recovery_limit",
  ]),
  recoveryCause: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
}) {}
