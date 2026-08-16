import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  hasStringAsync: vi.fn(),
  getStringAsync: vi.fn(),
}));

vi.mock("expo-clipboard", () => ({
  hasStringAsync: mocks.hasStringAsync,
  getStringAsync: mocks.getStringAsync,
}));

import { readTerminalClipboardText } from "./terminalClipboard";

describe("terminal clipboard", () => {
  beforeEach(() => {
    mocks.hasStringAsync.mockReset();
    mocks.getStringAsync.mockReset();
  });

  it("returns clipboard text", async () => {
    mocks.hasStringAsync.mockResolvedValue(true);
    mocks.getStringAsync.mockResolvedValue("pnpm test\n");

    await expect(readTerminalClipboardText()).resolves.toEqual({
      _tag: "text",
      text: "pnpm test\n",
    });
  });

  it("does not read non-text clipboard content", async () => {
    mocks.hasStringAsync.mockResolvedValue(false);

    await expect(readTerminalClipboardText()).resolves.toEqual({ _tag: "empty" });
    expect(mocks.getStringAsync).not.toHaveBeenCalled();
  });

  it("reports clipboard failures without throwing from the terminal action", async () => {
    const cause = new Error("clipboard unavailable");
    mocks.hasStringAsync.mockRejectedValue(cause);

    await expect(readTerminalClipboardText()).resolves.toEqual({
      _tag: "unavailable",
      cause,
    });
  });
});
