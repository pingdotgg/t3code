import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@react-navigation/native", () => ({
  DarkTheme: {
    dark: true,
    colors: {
      background: "dark-background",
      card: "dark-card",
      border: "dark-border",
      notification: "dark-notification",
      primary: "dark-primary",
      text: "dark-text",
    },
  },
  DefaultTheme: {
    dark: false,
    colors: {
      background: "light-background",
      card: "light-card",
      border: "light-border",
      notification: "light-notification",
      primary: "light-primary",
      text: "light-text",
    },
  },
}));

import { createManagedThemeColors } from "@t3tools/themes";

import { createMobileNavigationTheme } from "./mobileNavigationTheme";

describe("createMobileNavigationTheme", () => {
  it("keeps the stock light navigation chrome on the global.css surfaces", () => {
    const theme = createMobileNavigationTheme("light", null);

    expect(theme.colors.background).toBe("#f2f2f7");
    expect(theme.colors.card).toBe("rgba(242, 242, 247, 0.98)");
  });

  it("keeps the stock dark navigation chrome on the global.css surfaces", () => {
    const theme = createMobileNavigationTheme("dark", null);

    expect(theme.colors.background).toBe("#0a0a0a");
    expect(theme.colors.card).toBe("rgba(14, 14, 14, 0.98)");
  });

  it("uses the selected theme roles for navigation chrome", () => {
    const colors = createManagedThemeColors("light", "#f2f7fb", "#2878b8");
    const theme = createMobileNavigationTheme("light", colors);

    expect(theme.colors.background).toBe(colors.canvas);
    expect(theme.colors.card).toBe(colors.surfaceRaised);
    expect(theme.colors.text).toBe(colors.text);
  });
});
