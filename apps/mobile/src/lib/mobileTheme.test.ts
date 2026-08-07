import { describe, expect, it } from "vite-plus/test";

import { createManagedThemeColors } from "@t3tools/themes";

import {
  getDefaultMobileCSSVariables,
  MOBILE_THEME_VARIABLE_NAMES,
  themeColorsToMobileCSSVariables,
} from "./mobileTheme";

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

  it("keeps sidebar roles isolated and dims light modal backdrops", () => {
    const colors = createManagedThemeColors("light", "#f2f7fb", "#2878b8");
    const variables = themeColorsToMobileCSSVariables(colors);

    expect(variables["--color-sidebar-background"]).toBe(colors.sidebar);
    expect(variables["--color-foreground"]).toBe(colors.text);
    expect(variables["--color-backdrop"]).toContain("0.22");
    expect(variables["--color-backdrop"]).not.toBe(colors.surfaceOverlay);
  });

  it("exposes the exact stylesheet values used by the default reset", () => {
    expect(getDefaultMobileCSSVariables("light")["--color-screen"]).toBe("#f2f2f7");
    expect(getDefaultMobileCSSVariables("dark")["--color-screen"]).toBe("#0a0a0a");
    expect(getDefaultMobileCSSVariables("light")["--color-sidebar-background"]).toBe(
      "rgba(255, 255, 255, 0.99)",
    );
  });
});
