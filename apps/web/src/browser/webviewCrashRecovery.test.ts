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

  it("allows recovery again after the crash window expires", () => {
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
});
