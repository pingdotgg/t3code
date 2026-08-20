import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_THEMES, getThemeColorsForAppearance } from "@t3tools/shared/themePalettes";

import { themeColorToNativeColor } from "../../lib/mobileTheme";
import { parseMobileThemeFile } from "../../lib/mobileThemeFile";

import {
  buildGhosttyThemeConfig,
  getMobileTerminalTheme,
  getPierreTerminalTheme,
} from "./terminalTheme";

describe("getPierreTerminalTheme", () => {
  it("keeps the default light terminal output byte-for-byte stable", () => {
    expect(getPierreTerminalTheme("light")).toEqual({
      background: "#f2f2f7",
      foreground: "#6C6C71",
      mutedForeground: "#8E8E95",
      border: "#eeeeef",
      cursorForeground: "#009fff",
      cursorBackground: "#f2f2f7",
      palette: [
        "#1F1F21",
        "#ff2e3f",
        "#0dbe4e",
        "#ffca00",
        "#009fff",
        "#c635e4",
        "#08c0ef",
        "#c6c6c8",
        "#1F1F21",
        "#ff2e3f",
        "#0dbe4e",
        "#ffca00",
        "#009fff",
        "#c635e4",
        "#08c0ef",
        "#c6c6c8",
      ],
    });
  });

  it("keeps the default dark terminal output byte-for-byte stable", () => {
    expect(getPierreTerminalTheme("dark")).toEqual({
      background: "#0a0a0a",
      foreground: "#adadb1",
      mutedForeground: "#8E8E95",
      border: "#2e2e30",
      cursorForeground: "#009fff",
      cursorBackground: "#0a0a0a",
      palette: [
        "#141415",
        "#ff2e3f",
        "#0dbe4e",
        "#ffca00",
        "#009fff",
        "#c635e4",
        "#08c0ef",
        "#c6c6c8",
        "#141415",
        "#ff2e3f",
        "#0dbe4e",
        "#ffca00",
        "#009fff",
        "#c635e4",
        "#08c0ef",
        "#c6c6c8",
      ],
    });
  });
});

describe("getMobileTerminalTheme", () => {
  it("preserves the Pierre terminal for the default theme", () => {
    for (const scheme of ["light", "dark"] as const) {
      expect(getMobileTerminalTheme("t3-code", scheme)).toEqual(getPierreTerminalTheme(scheme));
    }
  });

  it("applies the selected palette without replacing ANSI status colors", () => {
    const standard = getMobileTerminalTheme("t3-code", "dark");
    const ocean = getMobileTerminalTheme("ocean", "dark");

    expect(ocean.background).not.toBe(standard.background);
    expect(ocean.cursorForeground).not.toBe(standard.cursorForeground);
    expect(ocean.palette).toEqual(standard.palette);
  });

  it("uses the canonical desktop terminal roles for built-in themes", () => {
    const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === "ocean")!;
    const colors = getThemeColorsForAppearance(theme, "dark")!;
    const terminal = getMobileTerminalTheme("ocean", "dark");

    expect(terminal.background).toBe(themeColorToNativeColor(colors.terminalBackground));
    expect(terminal.foreground).toBe(themeColorToNativeColor(colors.terminalForeground));
    expect(terminal.cursorForeground).toBe(themeColorToNativeColor(colors.terminalCursor));
  });

  it("uses imported terminal roles without changing the ANSI palette", () => {
    const imported = parseMobileThemeFile({
      version: 1,
      id: "custom-terminal",
      name: "Custom Terminal",
      appearance: "dark",
      colors: {
        terminalBackground: "#101820",
        terminalForeground: "#f2f3f4",
        terminalCursor: "#ffcc00",
      },
    });
    const terminal = getMobileTerminalTheme(imported.id, "dark", [imported]);

    expect(terminal.background).toBe("#101820");
    expect(terminal.foreground).toBe("#f2f3f4");
    expect(terminal.cursorForeground).toBe("#ffcc00");
    expect(terminal.palette).toEqual(getPierreTerminalTheme("dark").palette);
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
});
