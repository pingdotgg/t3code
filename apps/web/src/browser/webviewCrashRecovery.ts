export const WEBVIEW_CRASH_RECOVERY_WINDOW_MS = 30_000;
export const WEBVIEW_CRASH_RECOVERY_MAX_ATTEMPTS = 3;
export const WEBVIEW_CRASH_RECOVERY_BASE_DELAY_MS = 250;

export interface WebviewCrashRecoveryState {
  readonly attempts: number;
  readonly windowStartedAt: number | null;
}

export interface WebviewCrashRecoveryPlan {
  readonly delayMs: number;
  readonly state: WebviewCrashRecoveryState;
}

export const INITIAL_WEBVIEW_CRASH_RECOVERY_STATE: WebviewCrashRecoveryState = {
  attempts: 0,
  windowStartedAt: null,
};

/**
 * Bounded exponential backoff for reloading a crashed guest. A guest that
 * crashes on load would otherwise reload forever, so attempts are capped per
 * fixed window anchored at the first crash; `null` means stop retrying and
 * leave the failure visible. This bounds crash-reload loops rather than
 * precisely rate-limiting them: retries across a window boundary remain
 * bounded and self-limiting while preserving the upstream recovery behavior.
 */
export function planWebviewCrashRecovery(
  state: WebviewCrashRecoveryState,
  now: number,
): WebviewCrashRecoveryPlan | null {
  const startsNewWindow =
    state.windowStartedAt === null ||
    now - state.windowStartedAt >= WEBVIEW_CRASH_RECOVERY_WINDOW_MS;
  const attempts = startsNewWindow ? 0 : state.attempts;
  if (attempts >= WEBVIEW_CRASH_RECOVERY_MAX_ATTEMPTS) return null;

  const nextAttempts = attempts + 1;
  return {
    delayMs: WEBVIEW_CRASH_RECOVERY_BASE_DELAY_MS * 2 ** attempts,
    state: {
      attempts: nextAttempts,
      windowStartedAt: startsNewWindow ? now : state.windowStartedAt,
    },
  };
}
