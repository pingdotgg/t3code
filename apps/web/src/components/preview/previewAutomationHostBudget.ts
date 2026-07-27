/**
 * Reserve for delivering the host's response back to the broker once a wait
 * gives up. Without it a host wait that runs the full request budget always
 * loses the race to the broker's own deadline, so the agent sees an opaque
 * "timed out" instead of the specific failure the host was about to report.
 */
export const PREVIEW_HOST_RESPONSE_MARGIN_MS = 1_500;

/**
 * Share of the request budget reserved when the request is too short for the
 * full margin, so the host still expires first rather than being clamped past
 * the broker's deadline.
 */
const HOST_RESPONSE_MARGIN_FRACTION = 0.2;

/**
 * Budget a host-side wait so it always expires before the broker's deadline
 * for the same request.
 */
export function resolveHostWaitBudgetMs(requestTimeoutMs: number): number {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return 0;
  }
  const reservedMs = Math.min(
    PREVIEW_HOST_RESPONSE_MARGIN_MS,
    Math.ceil(requestTimeoutMs * HOST_RESPONSE_MARGIN_FRACTION),
  );
  return Math.max(0, requestTimeoutMs - reservedMs);
}
