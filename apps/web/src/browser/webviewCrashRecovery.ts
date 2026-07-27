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
