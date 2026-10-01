import type { Json } from "@t3tools/extension-sdk/contracts";
import {
  restoreStateValidator,
  type RestoreState,
  type RestoreStateSchema,
} from "@t3tools/extension-sdk/authoring";

/**
 * Reference persisted-state declaration. `as const` keeps the literal field
 * types so RestoreState derives the exact TypeScript shape session.save accepts.
 * `label` is optional: saves written before it existed still restore.
 */
export const persistedCounterSchema = {
  fields: { count: "number", label: "string" },
  optional: ["label"],
} as const satisfies RestoreStateSchema;

export type PersistedCounterState = RestoreState<typeof persistedCounterSchema>;

export const SURFACE_ID = "example.persisted-state/view";
export const STATE_VERSION = 1;

/** Accepts null (fresh view) or the declared shape; anything else throws an actionable error. */
export const validatePersistedCounter = restoreStateValidator(
  SURFACE_ID,
  STATE_VERSION,
  persistedCounterSchema,
);

/** Narrow session.restoreState to the declared shape; null means nothing was saved yet. */
export function readPersistedState(state: Json): PersistedCounterState | null {
  if (state === null) return null;
  validatePersistedCounter(state);
  return state as PersistedCounterState;
}
