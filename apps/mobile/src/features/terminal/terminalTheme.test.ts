import { describe, expect, it } from "vite-plus/test";

import {
  buildGhosttyThemeConfig,
  getPierreTerminalTheme,
  getTerminalThemeForColors,
} from "./terminalTheme";
import { createManagedThemeColors } from "@t3tools/themes";

describe("getPierreTerminalTheme", () => {
  it("returns the Pierre light terminal palette", () => {
    expect(getPierreTerminalTheme("light")).toMatchObject({
      background: "#f2f2f7",
      foreground: "#6C6C71",
      cursorForeground: "#009fff",
      cursorBackground: "#f2f2f7",
    });
  });

  it("returns the Pierre dark terminal palette", () => {
    expect(getPierreTerminalTheme("dark")).toMatchObject({
      background: "#0a0a0a",
      foreground: "#adadb1",
      cursorForeground: "#009fff",
      cursorBackground: "#0a0a0a",
    });
  });
});

describe("buildGhosttyThemeConfig", () => {
  it("serializes theme colors into a ghostty config file", () => {
    const config = buildGhosttyThemeConfig(getPierreTerminalTheme("dark"));

    expect(config).toContain("background = #0a0a0a");
    expect(config).toContain("foreground = #adadb1");
    expect(config).toContain("cursor-color = #009fff");
    expect(config).toContain("palette = 0=#141415");
    expect(config).toContain("palette = 15=#c6c6c8");
    expect(config.endsWith("\n")).toBe(true);
  });

  it("uses canonical terminal roles without changing ANSI-16", () => {
    const colors = createManagedThemeColors("dark", "#18212b", "#5ba8ff");
    const theme = getTerminalThemeForColors("dark", colors);
    const config = buildGhosttyThemeConfig(theme);
    const selectionEntry = config
      .split("\n")
      .find((line) => line.startsWith("selection-background = "));

    expect(config).toContain(`background = ${colors.terminalBackground}`);
    expect(config).toContain(`foreground = ${colors.terminalForeground}`);
    expect(config).toContain(`cursor-color = ${colors.terminalCursor}`);
    expect(selectionEntry?.split("=", 2)[1]?.trim()).toBe(colors.terminalSelection);
    expect(theme.palette).toEqual(getPierreTerminalTheme("dark").palette);
  });
});
