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

import {
  CopyTextClipboardWriteError,
  CopyTextHapticFeedbackError,
  copyTextWithHaptic,
} from "./copyTextWithHaptic";

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

  it("triggers haptic feedback without waiting for the clipboard promise", () => {
    copyTextWithHaptic("trace-123");

    expect(mocks.setStringAsync).toHaveBeenCalledWith("trace-123");
    expect(mocks.impactAsync).toHaveBeenCalledWith("light");
  });

  it("preserves selection feedback for thread work rows", () => {
    copyTextWithHaptic("work output", {
      target: "thread-work-row",
      feedback: "selection",
    });

    expect(mocks.setStringAsync).toHaveBeenCalledWith("work output");
    expect(mocks.selectionAsync).toHaveBeenCalledOnce();
    expect(mocks.impactAsync).not.toHaveBeenCalled();
  });

  it("reports structured failures without including clipboard contents", async () => {
    const clipboardCause = new Error("native clipboard failure");
    const hapticCause = new Error("native haptic failure");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.setStringAsync.mockRejectedValueOnce(clipboardCause);
    mocks.impactAsync.mockRejectedValueOnce(hapticCause);

    copyTextWithHaptic("secret clipboard contents", { target: "connection-trace-id" });

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledTimes(2);
    });

    const failures = consoleError.mock.calls.map(([failure]) => failure);
    const clipboardError = failures.find(
      (failure) => failure instanceof CopyTextClipboardWriteError,
    );
    expect(clipboardError).toBeInstanceOf(CopyTextClipboardWriteError);
    expect(clipboardError).toMatchObject({
      target: "connection-trace-id",
      cause: clipboardCause,
    });
    expect((clipboardError as Error).message).not.toContain("secret clipboard contents");

    const hapticError = failures.find((failure) => failure instanceof CopyTextHapticFeedbackError);
    expect(hapticError).toBeInstanceOf(CopyTextHapticFeedbackError);
    expect(hapticError).toMatchObject({
      target: "connection-trace-id",
      feedback: "light-impact",
      cause: hapticCause,
    });
    expect((hapticError as Error).message).not.toContain("secret clipboard contents");
  });
});
