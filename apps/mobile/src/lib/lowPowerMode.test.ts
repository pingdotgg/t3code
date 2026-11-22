import { describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  enabled: false,
  listeners: new Set<(state: { lowPowerMode: boolean }) => void>(),
  appStateListeners: new Set<(state: string) => void>(),
}));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.appStateListeners.add(listener);
      return { remove: () => native.appStateListeners.delete(listener) };
    },
  },
  AccessibilityInfo: { addEventListener: () => ({ remove: () => undefined }) },
}));

vi.mock("expo-battery", () => ({
  addLowPowerModeListener: (listener: (state: { lowPowerMode: boolean }) => void) => {
    native.listeners.add(listener);
    return { remove: () => native.listeners.delete(listener) };
  },
  isLowPowerModeEnabledAsync: () => Promise.resolve(native.enabled),
}));

import { readLowPowerModeEnabled, subscribeLowPowerMode } from "./lowPowerMode";

describe("low power mode store", () => {
  it("reads as on until seeded, then follows native changes", async () => {
    native.enabled = false;
    const changes = vi.fn();
    const unsubscribe = subscribeLowPowerMode(changes);
    expect(readLowPowerModeEnabled()).toBe(true);
    await Promise.resolve();
    expect(readLowPowerModeEnabled()).toBe(false);

    for (const listener of native.listeners) listener({ lowPowerMode: true });
    expect(readLowPowerModeEnabled()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(native.listeners.size).toBe(0);
    expect(native.appStateListeners.size).toBe(0);
  });

  it("rereads a change made while backgrounded when the app returns", async () => {
    native.enabled = false;
    const unsubscribe = subscribeLowPowerMode(() => undefined);
    await Promise.resolve();
    expect(readLowPowerModeEnabled()).toBe(false);

    // Android sends no power-saver event to a backgrounded app.
    native.enabled = true;
    for (const listener of native.appStateListeners) listener("active");
    await Promise.resolve();
    expect(readLowPowerModeEnabled()).toBe(true);
    unsubscribe();
  });
});
