import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_APPEARANCE_SETTINGS } from "@t3tools/contracts";
import {
  deriveAppearanceCssVariables,
  getAppearanceThemeById,
  getAppearanceThemes,
  resolveAppearanceTheme,
} from "./appearance.ts";

describe("appearance theme registry", () => {
  it("returns independent light and dark preset sets", () => {
    expect(getAppearanceThemes("light").every((theme) => theme.mode === "light")).toBe(true);
    expect(getAppearanceThemes("dark").every((theme) => theme.mode === "dark")).toBe(true);
  });

  it("returns themes sorted by name", () => {
    const themeNames = getAppearanceThemes().map((theme) => theme.name);
    expect(themeNames).toEqual([...themeNames].sort((left, right) => left.localeCompare(right)));
  });

  it("falls back to the default preset for missing selected ids", () => {
    expect(
      resolveAppearanceTheme({
        ...DEFAULT_APPEARANCE_SETTINGS,
        themeId: "missing",
      }).id,
    ).toBe(DEFAULT_APPEARANCE_SETTINGS.themeId);
  });

  it("derives consumed CSS variables from the resolved theme", () => {
    const theme = getAppearanceThemeById("solarized-light")!;
    const variables = deriveAppearanceCssVariables(theme);

    expect(variables["--background"]).toBe(theme.backgroundSeed);
    expect(variables["--primary"]).toBe(theme.accentSeed);
    expect(variables["--ring"]).toBe(theme.accentSeed);
    expect(variables["--border"]).toContain(theme.neutralSeed);
  });
});
