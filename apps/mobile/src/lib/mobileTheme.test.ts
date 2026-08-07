import { describe, expect, it } from "vite-plus/test";

import { createManagedThemeColors } from "@t3tools/themes";

import { MOBILE_THEME_VARIABLE_NAMES, themeColorsToMobileCSSVariables } from "./mobileTheme";

describe("themeColorsToMobileCSSVariables", () => {
  it("drives the primary action, status bar, and translucent tokens from the palette", () => {
    const colors = createManagedThemeColors("light", "#f2f7fb", "#2878b8");
    const variables = themeColorsToMobileCSSVariables(colors);

    expect(variables["--color-primary"]).toBe(colors.accent);
    expect(variables["--color-status-bar"]).toBe(colors.canvas);
    expect(variables["--color-backdrop"]).toMatch(/^rgba\(/);
    expect(variables["--color-primary-shadow"]).toMatch(/^rgba\(/);
  });

  it("keeps the CSS bridge table auditable", () => {
    const colors = createManagedThemeColors("dark", "#1b2938", "#70b9ee");
    const variables = themeColorsToMobileCSSVariables(colors);

    for (const variable of MOBILE_THEME_VARIABLE_NAMES) {
      expect(variables[variable]).toBeDefined();
    }
  });
});
