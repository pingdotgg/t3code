/**
 * Pure state-derivation helper for the NeedsYouInboxScreen.
 *
 * Given the raw async state, returns a discriminated union describing which
 * view to render, keeping that logic out of the component and fully testable.
 */

export type InboxViewState =
  | { readonly kind: "skeleton" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" }
  | { readonly kind: "list"; readonly partialErrorMessage: string | null };

/**
 * Derive the correct view state from raw async state.
 *
 * Rules:
 * - `loading` + no rows yet (initial load, not pull-to-refresh) → skeleton
 * - `!loading` + zero rows + error   → error (full failure)
 * - `!loading` + zero rows + no error → empty (all caught up)
 * - rows present                     → list (may include a partial-error banner)
 */
export function deriveInboxViewState(opts: {
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly rows: readonly unknown[];
  readonly error: string | null;
  readonly partialError: string | null;
}): InboxViewState {
  const { loading, refreshing, rows, error, partialError } = opts;

  // Show skeleton only during the initial load (not during pull-to-refresh).
  if (loading && !refreshing && rows.length === 0) {
    return { kind: "skeleton" };
  }

  // Full failure: fetch finished, no rows at all, at least one error.
  if (!loading && rows.length === 0 && error !== null) {
    return { kind: "error", message: error };
  }

  // True empty: fetch finished cleanly with no rows.
  if (!loading && rows.length === 0 && error === null) {
    return { kind: "empty" };
  }

  // We have rows (possibly with a partial failure banner).
  return { kind: "list", partialErrorMessage: partialError };
}
