import * as Equal from "effect/Equal";

/**
 * Reads a server value against the editor's writes still in flight. Matching one acknowledges
 * it and every earlier write; anything else came from elsewhere and replaces the draft.
 */
export function reconcileSnoozeDraft<T>(
  pending: ReadonlyArray<T>,
  saved: T,
): { readonly adopt: true } | { readonly adopt: false; readonly pending: ReadonlyArray<T> } {
  const acknowledged = pending.findIndex((snapshot) => Equal.equals(snapshot, saved));
  return acknowledged === -1
    ? { adopt: true }
    : { adopt: false, pending: pending.slice(acknowledged + 1) };
}
