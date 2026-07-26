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
