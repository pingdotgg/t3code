type RefreshVcsRefs = () => void;

export function refreshVcsRefsOnMenuOpen(
  open: boolean,
  ...refreshes: ReadonlyArray<RefreshVcsRefs>
): void {
  if (!open) return;
  for (const refresh of refreshes) refresh();
}
