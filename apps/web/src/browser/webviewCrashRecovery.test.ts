import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
  planWebviewCrashRecovery,
  WEBVIEW_CRASH_RECOVERY_WINDOW_MS,
} from "./webviewCrashRecovery";

describe("planWebviewCrashRecovery", () => {
  it("backs off and stops after a bounded number of rapid crashes", () => {
    const first = planWebviewCrashRecovery(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE, 1_000);
    expect(first).not.toBeNull();
    expect(first?.delayMs).toBe(250);

    const second = planWebviewCrashRecovery(first!.state, 1_100);
    expect(second).not.toBeNull();
    expect(second?.delayMs).toBe(500);

    const third = planWebviewCrashRecovery(second!.state, 1_200);
    expect(third).not.toBeNull();
    expect(third?.delayMs).toBe(1_000);

    expect(planWebviewCrashRecovery(third!.state, 1_300)).toBeNull();
  });

  it("resets the attempt cap when the fixed first-crash window expires", () => {
    const first = planWebviewCrashRecovery(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE, 1_000)!;
    const second = planWebviewCrashRecovery(first.state, 1_100)!;
    const third = planWebviewCrashRecovery(second.state, 1_200)!;

    expect(planWebviewCrashRecovery(third.state, 1_000 + WEBVIEW_CRASH_RECOVERY_WINDOW_MS)).toEqual(
      {
        delayMs: 250,
        state: {
          attempts: 1,
          windowStartedAt: 1_000 + WEBVIEW_CRASH_RECOVERY_WINDOW_MS,
        },
      },
    );
  });

  it("keeps the window anchored to the first crash while retrying", () => {
    const first = planWebviewCrashRecovery(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE, 1_000)!;
    const second = planWebviewCrashRecovery(first.state, 20_000)!;

    expect(second.state.windowStartedAt).toBe(1_000);
    expect(planWebviewCrashRecovery(second.state, 25_000)?.delayMs).toBe(1_000);
  });

  it("allows another bounded sequence immediately after the fixed-window boundary", () => {
    const first = planWebviewCrashRecovery(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE, 0)!;
    const second = planWebviewCrashRecovery(first.state, 100)!;
    const third = planWebviewCrashRecovery(second.state, 200)!;

    const afterBoundary = planWebviewCrashRecovery(third.state, WEBVIEW_CRASH_RECOVERY_WINDOW_MS)!;

    expect(afterBoundary.delayMs).toBe(250);
    expect(afterBoundary.state).toEqual({
      attempts: 1,
      windowStartedAt: WEBVIEW_CRASH_RECOVERY_WINDOW_MS,
    });
  });
});
