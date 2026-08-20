import { describe, expect, it } from "vite-plus/test";

import { resolveSyncedThemeHalfMutation } from "./useSettings";

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
});
