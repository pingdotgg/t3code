/**
 * Reserve for delivering the host's response back to the broker once a wait
 * gives up. Without it a host wait that runs the full request budget always
 * loses the race to the broker's own deadline, so the agent sees an opaque
 * "timed out" instead of the specific failure the host was about to report.
 */
export const PREVIEW_HOST_RESPONSE_MARGIN_MS = 1_500;

/** Smallest useful wait; below this a slow first poll would fail instantly. */
const MIN_HOST_WAIT_MS = 250;

/**
 * Budget a host-side wait so it expires before the broker's deadline for the
 * same request.
 */
export function resolveHostWaitBudgetMs(requestTimeoutMs: number): number {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return MIN_HOST_WAIT_MS;
  }
  return Math.max(MIN_HOST_WAIT_MS, requestTimeoutMs - PREVIEW_HOST_RESPONSE_MARGIN_MS);
}
