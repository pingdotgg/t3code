import { describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  enabled: false,
  listeners: new Set<(enabled: boolean) => void>(),
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: vi.fn() },
  AccessibilityInfo: {
    addEventListener: (_event: string, listener: (enabled: boolean) => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
    isReduceMotionEnabled: () => Promise.resolve(native.enabled),
  },
}));

import { readReduceMotionEnabled, subscribeReduceMotion } from "./appState";

describe("reduce motion store", () => {
  it("reseeds from native after observation stops and restarts", async () => {
    native.enabled = false;
    const unsubscribe = subscribeReduceMotion(() => undefined);
    await Promise.resolve();
    expect(readReduceMotionEnabled()).toBe(false);
    unsubscribe();

    // Changed while nobody listened: no event reaches the store.
    native.enabled = true;
    const unsubscribeAgain = subscribeReduceMotion(() => undefined);
    // Unknown until the reseed lands, which reads as reduced, not the stale false.
    expect(readReduceMotionEnabled()).toBe(true);
    await Promise.resolve();
    expect(readReduceMotionEnabled()).toBe(true);
    unsubscribeAgain();
  });

  it("ignores a seed that resolves after the last unsubscribe", async () => {
    native.enabled = false;
    subscribeReduceMotion(() => undefined)();
    await Promise.resolve();
    expect(readReduceMotionEnabled()).toBe(true);
  });
});
