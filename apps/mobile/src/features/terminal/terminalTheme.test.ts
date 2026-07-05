import { describe, expect, it } from "vite-plus/test";

import { buildGhosttyThemeConfig, getPierreTerminalTheme } from "./terminalTheme";

describe("getPierreTerminalTheme", () => {
  it("returns the Pierre light terminal palette", () => {
    expect(getPierreTerminalTheme("light")).toMatchObject({
      background: "#f2f4f0",
      foreground: "#6C6C71",
      cursorForeground: "#4c755c",
      cursorBackground: "#f2f4f0",
    });
  });

  it("returns the Pierre dark terminal palette", () => {
    expect(getPierreTerminalTheme("dark")).toMatchObject({
      background: "#0b0d0b",
      foreground: "#adadb1",
      cursorForeground: "#6e9a7d",
      cursorBackground: "#0b0d0b",
    });
  });
});

describe("buildGhosttyThemeConfig", () => {
  it("serializes theme colors into a ghostty config file", () => {
    const config = buildGhosttyThemeConfig(getPierreTerminalTheme("dark"));

    expect(config).toContain("background = #0b0d0b");
    expect(config).toContain("foreground = #adadb1");
    expect(config).toContain("cursor-color = #6e9a7d");
    expect(config).toContain("palette = 0=#141415");
    expect(config).toContain("palette = 15=#c6c6c8");
    expect(config.endsWith("\n")).toBe(true);
  });
});
