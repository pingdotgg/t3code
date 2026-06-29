import * as Schema from "effect/Schema";

/**
 * ProviderInstanceNotFoundError - Lookup against the instance registry failed.
 *
 * The driver may be registered, but no instance with the requested id has
 * been bootstrapped — typically because
 * the persisted instance id refers to an instance the user removed from
 * settings, or because routing is asked for an instance before the registry
 * has finished its first reload.
 */
export class ProviderInstanceNotFoundError extends Schema.TaggedErrorClass<ProviderInstanceNotFoundError>()(
  "ProviderInstanceNotFoundError",
  {
    instanceId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No provider instance bound to id '${this.instanceId}'`;
  }
}

/**
 * ProviderDriverError - A driver `create` call failed before producing an
 * instance. Surfaced to the registry, which marks the offending entry as
 * an "unavailable" shadow snapshot rather than crashing the server.
 */
export class ProviderDriverError extends Schema.TaggedErrorClass<ProviderDriverError>()(
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
