// @effect-diagnostics globalTimers:off -- React owns this page-lifetime timer outside an Effect runtime.
/** Refresh cadence for a usage page that remains mounted. */
export const USAGE_AUTO_REFRESH_MS = 30 * 60 * 1000;

/**
 * Refreshes on page mount, then starts the page-lifetime refresh timer.
 */
export function startUsageAutoRefresh(refresh: () => void): () => void {
  refresh();
  const timer = globalThis.setInterval(refresh, USAGE_AUTO_REFRESH_MS);
  return () => globalThis.clearInterval(timer);
}
