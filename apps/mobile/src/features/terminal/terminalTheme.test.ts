import { describe, expect, it } from "vite-plus/test";

import { buildGhosttyThemeConfig, getPierreTerminalTheme } from "./terminalTheme";

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

  it("themes native surface roles without changing ANSI colors", () => {
    const base = getPierreTerminalTheme("dark");
    const themed = getPierreTerminalTheme("dark", {
      terminalBackground: "#101820",
      terminalForeground: "#f0f4f8",
      mutedForeground: "#8795a1",
      border: "#334455",
      terminalCursor: "#44aaff",
    });

    expect(themed).toMatchObject({
      background: "#101820",
      foreground: "#f0f4f8",
      mutedForeground: "#8795a1",
      border: "#334455",
      cursorForeground: "#44aaff",
      cursorBackground: "#101820",
    });
    expect(themed.palette).toEqual(base.palette);
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

  it("serializes native terminal alpha colors in CSS RRGGBBAA order", () => {
    const theme = getPierreTerminalTheme("dark", {
      terminalBackground: "#11223344",
      terminalForeground: "#55667788",
      terminalCursor: "#99aabbcc",
      mutedForeground: "#ddeeff11",
      border: "#22446680",
    });

    expect({
      backgroundColor: theme.background,
      foregroundColor: theme.foreground,
      mutedForegroundColor: theme.mutedForeground,
    }).toEqual({
      backgroundColor: "#11223344",
      foregroundColor: "#55667788",
      mutedForegroundColor: "#ddeeff11",
    });
    expect(buildGhosttyThemeConfig(theme)).toContain("cursor-color = #99aabbcc");
  });
});
