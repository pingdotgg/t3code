import { describe, expect, it } from "vite-plus/test";

import {
  isAndroidKeyboardAnimationUsable,
  reduceAndroidKeyboardRecovery,
  type AndroidKeyboardRecoveryState,
} from "./androidKeyboardRecovery";

describe("reduceAndroidKeyboardRecovery", () => {
  it("quarantines keyboard translation after the app resumes", () => {
    expect(reduceAndroidKeyboardRecovery("ready", "resume")).toBe("quarantined");
  });

  it("keeps the quarantine while the keyboard snapshot is unchanged", () => {
    let state: AndroidKeyboardRecoveryState = "ready";
    state = reduceAndroidKeyboardRecovery(state, "resume");
    state = reduceAndroidKeyboardRecovery(state, "resume");

    expect(state).toBe("quarantined");
    expect(
      isAndroidKeyboardAnimationUsable({
        isKeyboardVisible: true,
        isQuarantined: state === "quarantined",
      }),
    ).toBe(false);
  });

  it("releases the quarantine when a live keyboard or input event arrives", () => {
    expect(reduceAndroidKeyboardRecovery("quarantined", "keyboard-show")).toBe("ready");
    expect(reduceAndroidKeyboardRecovery("quarantined", "input-focus")).toBe("ready");
  });
});
