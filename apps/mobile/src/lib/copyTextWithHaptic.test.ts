import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  impactAsync: vi.fn(),
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
}));

import { copyTextWithHaptic } from "./copyTextWithHaptic";

describe("copyTextWithHaptic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setStringAsync.mockReturnValue(new Promise<void>(() => undefined));
    mocks.impactAsync.mockResolvedValue(undefined);
  });

  it("triggers haptic feedback without waiting for the clipboard promise", () => {
    copyTextWithHaptic("trace-123");

    expect(mocks.setStringAsync).toHaveBeenCalledWith("trace-123");
    expect(mocks.impactAsync).toHaveBeenCalledWith("light");
  });
});
