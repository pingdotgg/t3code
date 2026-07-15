import * as Schema from "effect/Schema";

export class SubAgentError extends Schema.TaggedError<SubAgentError>()(
  "SubAgentError",
  {
    reason: Schema.Literals([
      "provider-not-found",
      "provider-not-spawnable",
      "model-not-found",
      "concurrency-limit-exceeded",
      "thread-not-found",
      "invalid-status",
      "dispatch-failed",
      "capability-unavailable",
      "depth-limit-exceeded",
      "caller-thread-not-found",
      "model-not-resolved",
    ]),
    description: Schema.String,
  },
) {}
