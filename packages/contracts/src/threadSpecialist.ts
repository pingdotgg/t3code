import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Stable project-scoped handle for a durable specialist thread, like OpenRig's
 * `dev-ui@factory`. Lowercase slug so agents can address it without fuzzy title match.
 */
export const ThreadSpecialistKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) =>
    /^[a-z][a-z0-9-]{0,62}$/.test(value)
      ? true
      : "A specialist key must be a lowercase slug (letters, digits, hyphens).",
  ),
);
export type ThreadSpecialistKey = typeof ThreadSpecialistKey.Type;

export const ThreadSpecialistLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ThreadSpecialistLabel = typeof ThreadSpecialistLabel.Type;

export const ThreadSpecialistInstructions = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));
export type ThreadSpecialistInstructions = typeof ThreadSpecialistInstructions.Type;

export const ThreadSpecialist = Schema.Struct({
  key: ThreadSpecialistKey,
  label: ThreadSpecialistLabel,
  /** Domain brief kept with the binding; prompt injection lands in a later slice. */
  instructions: Schema.optional(ThreadSpecialistInstructions),
});
export type ThreadSpecialist = typeof ThreadSpecialist.Type;
