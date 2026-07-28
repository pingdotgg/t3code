type RefreshVcsRefs = () => void;

export function resetVcsRefQueryOrRefresh(
  query: string,
  resetQuery: () => void,
  ...refreshes: ReadonlyArray<RefreshVcsRefs>
): void {
  if (query.trim().length > 0) {
    resetQuery();
    return;
  }
  for (const refresh of refreshes) refresh();
}

export function refreshVcsRefsOnMenuOpen(
  open: boolean,
  ...refreshes: ReadonlyArray<RefreshVcsRefs>
): void {
  if (!open) return;
  for (const refresh of refreshes) refresh();
}

export function resetVcsRefQueriesOnMenuClose(
  open: boolean,
  ...resets: ReadonlyArray<() => void>
): void {
  if (open) return;
  for (const reset of resets) reset();
}

export function refreshVcsRefsAfterQueryReset(
  open: boolean,
  shouldRefresh: boolean,
  query: string,
  clearPendingRefresh: () => void,
  ...refreshes: ReadonlyArray<RefreshVcsRefs>
): void {
  if (!open || !shouldRefresh || query.trim().length > 0) return;
  clearPendingRefresh();
  for (const refresh of refreshes) refresh();
}
