import * as Schema from "effect/Schema";

/**
 * ProviderDriverError - A driver `create` call failed before producing an
 * instance. Surfaced to the registry, which marks the offending entry as
 * an "unavailable" shadow snapshot rather than crashing the server.
 */
export class ProviderDriverError extends Schema.TaggedError<ProviderDriverError>()(
  "ProviderDriverError",
  {
    driver: Schema.String,
    instanceId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider driver '${this.driver}' failed to create instance '${this.instanceId}': ${this.detail}`;
  }
}
