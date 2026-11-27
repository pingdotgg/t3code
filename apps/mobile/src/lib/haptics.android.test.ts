import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  performAndroidHapticsAsync: vi.fn(async (_type: string) => {}),
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async (_type?: string) => {}),
  selectionAsync: vi.fn(async () => {}),
}));

vi.mock("react-native", () => ({
  Platform: {
    get Version() {
      return 30;
    },
  },
}));

vi.mock("expo-haptics", () => ({
  ...native,
  AndroidHaptics: {
    Clock_Tick: "clock-tick",
    Confirm: "confirm",
    Context_Click: "context-click",
    Long_Press: "long-press",
    Reject: "reject",
  },
  ImpactFeedbackStyle: {
    Light: "light",
    Medium: "medium",
    Heavy: "heavy",
    Soft: "soft",
    Rigid: "rigid",
  },
  NotificationFeedbackType: {
    Success: "success",
    Warning: "warning",
    Error: "error",
  },
}));

import { Platform } from "react-native";

import {
  impactAsync,
  ImpactFeedbackStyle,
  notificationAsync,
  NotificationFeedbackType,
  selectionAsync,
} from "./haptics.android";

it.each([
  ["selection", () => selectionAsync(), "clock-tick"],
  ["light", () => impactAsync(ImpactFeedbackStyle.Light), "clock-tick"],
  ["soft", () => impactAsync(ImpactFeedbackStyle.Soft), "clock-tick"],
  ["medium", () => impactAsync(ImpactFeedbackStyle.Medium), "context-click"],
  ["rigid", () => impactAsync(ImpactFeedbackStyle.Rigid), "context-click"],
  ["heavy", () => impactAsync(ImpactFeedbackStyle.Heavy), "long-press"],
  ["default impact", () => impactAsync(), "context-click"],
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

it.each([
  ["default notification", () => notificationAsync(), "confirm"],
  ["success", () => notificationAsync(NotificationFeedbackType.Success), "confirm"],
  ["error", () => notificationAsync(NotificationFeedbackType.Error), "reject"],
] as const)("uses Android 11+ native notification touch feedback for %s", async (_, run, type) => {
  vi.clearAllMocks();
  using _version = vi.spyOn(Platform, "Version", "get").mockReturnValue(30);

  await run();

  expect(native.performAndroidHapticsAsync).toHaveBeenCalledExactlyOnceWith(type);
  expect(native.notificationAsync).not.toHaveBeenCalled();
});

it.each([
  ["warning on API 30+", 30, NotificationFeedbackType.Warning],
  ["success below API 30", 29, NotificationFeedbackType.Success],
  ["error below API 30", 29, NotificationFeedbackType.Error],
] as const)("falls back to Expo notification feedback for %s", async (_, version, type) => {
  vi.clearAllMocks();
  using _version = vi.spyOn(Platform, "Version", "get").mockReturnValue(version);

  await notificationAsync(type);

  expect(native.notificationAsync).toHaveBeenCalledExactlyOnceWith(type);
  expect(native.performAndroidHapticsAsync).not.toHaveBeenCalled();
});
