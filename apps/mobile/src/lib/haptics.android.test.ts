import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  performAndroidHapticsAsync: vi.fn(async (_type: string) => {}),
  impactAsync: vi.fn(async () => {}),
  selectionAsync: vi.fn(async () => {}),
}));

vi.mock("expo-haptics", () => ({
  ...native,
  AndroidHaptics: {
    Clock_Tick: "clock-tick",
    Context_Click: "context-click",
    Long_Press: "long-press",
  },
  ImpactFeedbackStyle: {
    Light: "light",
    Medium: "medium",
    Heavy: "heavy",
    Soft: "soft",
    Rigid: "rigid",
  },
}));

import { impactAsync, ImpactFeedbackStyle, selectionAsync } from "./haptics.android";

it.each([
  ["selection", () => selectionAsync(), "clock-tick"],
  ["light", () => impactAsync(ImpactFeedbackStyle.Light), "clock-tick"],
  ["soft", () => impactAsync(ImpactFeedbackStyle.Soft), "clock-tick"],
  ["medium", () => impactAsync(ImpactFeedbackStyle.Medium), "context-click"],
  ["rigid", () => impactAsync(ImpactFeedbackStyle.Rigid), "context-click"],
  ["heavy", () => impactAsync(ImpactFeedbackStyle.Heavy), "long-press"],
  ["default", () => impactAsync(), "context-click"],
] as const)(
  "uses Android touch feedback for %s instead of vibration waveforms",
  async (_, run, type) => {
    vi.clearAllMocks();

    await run();

    expect(native.performAndroidHapticsAsync).toHaveBeenCalledExactlyOnceWith(type);
    expect(native.impactAsync).not.toHaveBeenCalled();
    expect(native.selectionAsync).not.toHaveBeenCalled();
  },
);
