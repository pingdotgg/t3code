import { describe, expect, it } from "vite-plus/test";

import { getShortcutRuntime, resolveShortcutRuntime, setShortcutRuntime } from "./shortcutRuntime";

describe("resolveShortcutRuntime", () => {
  it("flips only for a browser session with the setting enabled", () => {
    expect(resolveShortcutRuntime({ isElectron: false, modKeyFlipEnabled: true })).toBe("browser");
    expect(resolveShortcutRuntime({ isElectron: false, modKeyFlipEnabled: false })).toBe("desktop");
  });

  it("never flips inside the desktop app", () => {
    expect(resolveShortcutRuntime({ isElectron: true, modKeyFlipEnabled: true })).toBe("desktop");
    expect(resolveShortcutRuntime({ isElectron: true, modKeyFlipEnabled: false })).toBe("desktop");
  });

  it("defaults to the pre-flip runtime until startup syncs it", () => {
    const previous = getShortcutRuntime();
    try {
      setShortcutRuntime("desktop");
      expect(getShortcutRuntime()).toBe("desktop");
      setShortcutRuntime("browser");
      expect(getShortcutRuntime()).toBe("browser");
    } finally {
      setShortcutRuntime(previous);
    }
  });
});
