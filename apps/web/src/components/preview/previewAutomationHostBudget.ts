/** Allow time to deliver an overlay failure before the broker times out. */
export const PREVIEW_HOST_RESPONSE_MARGIN_MS = 1_500;

const HOST_RESPONSE_MARGIN_FRACTION = 0.2;

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

/** Both readiness probes and polling delays share the request's host deadline. */
export async function waitForHostReadiness(
  deadlineMs: number,
  isReady: () => Promise<boolean>,
): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let ready: boolean | null;
    try {
      ready = await Promise.race([
        isReady(),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), Math.max(0, deadlineMs - Date.now()));
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (ready) return true;
    if (ready === null || Date.now() >= deadlineMs) return false;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(50, deadlineMs - Date.now())),
    );
  }
  return false;
}
