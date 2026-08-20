import { describe, expect, it, vi } from "vite-plus/test";

import {
  applySyncedThemeHalfMutation,
  resolveSyncedThemeHalfMutation,
  syncedThemePairPatch,
} from "./useSettings";

describe("theme half preference sync", () => {
  it("resets a custom base before applying T3 Code to one system-mode half", () => {
    expect(resolveSyncedThemeHalfMutation("dracula", null, "system", "light", "system")).toEqual({
      type: "reset-base",
      baseTheme: "system",
      preservedAppearance: "dark",
      preservedTheme: "dracula",
    });
  });

  it("updates one half without collapsing the opposite selection", () => {
    expect(
      resolveSyncedThemeHalfMutation(
        "system",
        { light: "catppuccin-latte", dark: "dracula" },
        "system",
        "dark",
        "tokyo-night",
      ),
    ).toEqual({ type: "set-half", appearance: "dark", theme: "tokyo-night" });
  });

  it("publishes both halves when a mixed selection is cleared", () => {
    expect(syncedThemePairPatch("system")).toEqual({
      lightThemeId: "t3-code",
      darkThemeId: "t3-code",
    });
    expect(syncedThemePairPatch("ocean")).toEqual({
      lightThemeId: "ocean",
      darkThemeId: "ocean",
    });
  });

  it("does not accept a failed local half write", () => {
    const writer = {
      setTheme: vi.fn(() => true),
      setThemeHalf: vi.fn(() => false),
    };

    expect(
      applySyncedThemeHalfMutation({
        mutation: { type: "set-half", appearance: "light", theme: "dracula" },
        previousBaseTheme: "system",
        previousThemeHalves: null,
        writer,
      }),
    ).toBe(false);
    expect(writer.setTheme).not.toHaveBeenCalled();
  });

  it("restores the previous base when preserving the opposite half fails", () => {
    const writer = {
      setTheme: vi.fn(() => true),
      setThemeHalf: vi.fn(() => false),
    };

    expect(
      applySyncedThemeHalfMutation({
        mutation: {
          type: "reset-base",
          baseTheme: "system",
          preservedAppearance: "dark",
          preservedTheme: "dracula",
        },
        previousBaseTheme: "dracula",
        previousThemeHalves: null,
        writer,
      }),
    ).toBe(false);
    expect(writer.setTheme).toHaveBeenNthCalledWith(1, "system");
    expect(writer.setTheme).toHaveBeenNthCalledWith(2, "dracula");
  });
});
