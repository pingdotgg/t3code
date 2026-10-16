import * as Schema from "effect/Schema";

/**
 * Lives in its own module so both the settings and the usage-limit contracts
 * can import it without importing each other.
 */
export const UsageLimitSourceId = Schema.String.pipe(Schema.brand("UsageLimitSourceId"));
export type UsageLimitSourceId = typeof UsageLimitSourceId.Type;
