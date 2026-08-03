/**
 * Folding paged commit-log reads into one loaded list.
 *
 * The history view pages backwards with a cursor, so the client can hold
 * several pages while a push only ever re-reads the newest one. Replacing the
 * whole list with that page would silently throw away every older page the user
 * loaded; refetching the accumulated window instead costs a full log read on
 * every refresh.
 */

import type { WorkingCopyLogEntry } from "./types";

export interface LogPageState {
  readonly entries: ReadonlyArray<WorkingCopyLogEntry>;
  /** Whether git has commits beyond the loaded list. Answered by the server. */
  readonly hasMore: boolean;
}

/**
 * Fold a freshly-read FIRST page into an already-loaded log.
 *
 * Splice, do not replace. If the fresh page still contains a commit already
 * loaded, the older tail below it is still valid and is kept. If it does not —
 * a rebase, a hard reset, or simply more new commits than one page — the tail
 * can no longer be trusted to join up and the fresh page stands alone.
 */
export function mergeLogHead(
  existing: ReadonlyArray<WorkingCopyLogEntry>,
  fresh: ReadonlyArray<WorkingCopyLogEntry>,
  options: { readonly freshHasMore: boolean; readonly existingHasMore: boolean },
): LogPageState {
  const anchorHash = fresh[fresh.length - 1]?.hash;
  if (anchorHash === undefined) {
    return { entries: [...fresh], hasMore: options.freshHasMore };
  }
  const anchor = existing.findIndex((entry) => entry.hash === anchorHash);
  if (anchor < 0) {
    return { entries: [...fresh], hasMore: options.freshHasMore };
  }
  const tail = existing.slice(anchor + 1);
  if (tail.length === 0) {
    return { entries: [...fresh], hasMore: options.freshHasMore };
  }
  // The tail is intact, so the deepest page's answer is still the right one.
  return { entries: [...fresh, ...tail], hasMore: options.existingHasMore };
}

/** Append an older page, dropping any hash already present (a re-issued page). */
export function appendLogPage(
  existing: ReadonlyArray<WorkingCopyLogEntry>,
  older: ReadonlyArray<WorkingCopyLogEntry>,
): ReadonlyArray<WorkingCopyLogEntry> {
  const seen = new Set(existing.map((entry) => entry.hash));
  return [...existing, ...older.filter((entry) => !seen.has(entry.hash))];
}

/**
 * `mergeLogHead` / `appendLogPage` behind one call, returning the PREVIOUS
 * state object unchanged when nothing moved so list item identity — and with it
 * the virtualizer's scroll position — survives an idle refresh.
 */
export function applyLogPage(
  state: LogPageState,
  page: { readonly entries: ReadonlyArray<WorkingCopyLogEntry>; readonly hasMore: boolean },
  mode: "head" | "append",
): LogPageState {
  const next: LogPageState =
    mode === "append"
      ? { entries: appendLogPage(state.entries, page.entries), hasMore: page.hasMore }
      : mergeLogHead(state.entries, page.entries, {
          freshHasMore: page.hasMore,
          existingHasMore: state.hasMore,
        });

  if (next.hasMore !== state.hasMore || next.entries.length !== state.entries.length) {
    return next;
  }
  for (const [index, entry] of next.entries.entries()) {
    if (entry.hash !== state.entries[index]?.hash) {
      return next;
    }
  }
  return state;
}

export const EMPTY_LOG_PAGE_STATE: LogPageState = { entries: [], hasMore: false };

/**
 * The cursor for the next page: the oldest loaded hash. The server pages with
 * `--skip=1 <hash>` rather than `<hash>~1`, because `~1` follows the first
 * parent and drops the second-parent side of a merge.
 */
export function nextLogCursor(state: LogPageState): string | null {
  if (!state.hasMore) {
    return null;
  }
  return state.entries[state.entries.length - 1]?.hash ?? null;
}
