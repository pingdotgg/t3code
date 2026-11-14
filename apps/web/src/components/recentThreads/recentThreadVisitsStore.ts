/** This window's thread visits, most recent first. Lives in memory only. */
let visits: readonly string[] = [];

export function readThreadVisits(): readonly string[] {
  return visits;
}

export function recordThreadVisit(threadKey: string): void {
  visits = [threadKey, ...visits.filter((key) => key !== threadKey)];
}

let switcherOpen = false;
const switcherOpenListeners = new Set<() => void>();

export function isRecentThreadSwitcherOpen(): boolean {
  return switcherOpen;
}

export function setRecentThreadSwitcherOpen(open: boolean): void {
  if (open === switcherOpen) return;
  switcherOpen = open;
  for (const listener of switcherOpenListeners) listener();
}

export function subscribeToRecentThreadSwitcherOpen(listener: () => void): () => void {
  switcherOpenListeners.add(listener);
  return () => switcherOpenListeners.delete(listener);
}
