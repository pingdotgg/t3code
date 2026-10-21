import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  impactAsync: vi.fn(),
  selectionAsync: vi.fn(),
  setStringAsync: vi.fn(),
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: mocks.setStringAsync,
}));

vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: {
    Light: "light",
  },
  impactAsync: mocks.impactAsync,
  selectionAsync: mocks.selectionAsync,
}));

import { tryCopyTextWithHaptic } from "./copyTextWithHaptic";

describe("copyTextWithHaptic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setStringAsync.mockReturnValue(new Promise<void>(() => undefined));
    mocks.impactAsync.mockResolvedValue(undefined);
    mocks.selectionAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports structured failures without including clipboard contents", async () => {
    const content = "https://accounts.google.com/auth?state=private-state&code=private-code";
    const clipboardCause = new Error(`Cannot copy ${content}`);
    const hapticCause = new Error(`Native failure for ${content}`);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.setStringAsync.mockRejectedValueOnce(clipboardCause);
    mocks.impactAsync.mockRejectedValueOnce(hapticCause);

    await tryCopyTextWithHaptic(content, { target: "provider-sign-in-link" });

    expect(consoleError).toHaveBeenCalledWith(
      "Failed to copy provider-sign-in-link to the clipboard.",
      expect.objectContaining({
        _tag: "CopyTextClipboardWriteError",
        target: "provider-sign-in-link",
      }),
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to trigger light-impact haptic feedback after copying provider-sign-in-link.",
      expect.objectContaining({ _tag: "CopyTextHapticFeedbackError", feedback: "light-impact" }),
    );
    const diagnostics = JSON.stringify(consoleError.mock.calls);
    expect(diagnostics).not.toContain("private-state");
    expect(diagnostics).not.toContain("private-code");
    expect(diagnostics).not.toContain("cause");
  });
});
