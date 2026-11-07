import { describe, expect, it } from "vite-plus/test";
import {
  setThemeSourceRole,
  parseThemeSource,
  resolveThemeSource,
  themeColorToHex,
  themeSourceFromColors,
} from "./themeResolution.ts";

describe("authored theme resolution", () => {
  it("inherits family changes while preserving explicit colors until reset", () => {
    const source = parseThemeSource({
      version: 2,
      seed: { canvas: "#101010", accent: "#123456" },
      overrides: { focus: "#ff0000", terminalBackground: "#002200", sidebarForeground: "#abcdef" },
    });
    const edited = setThemeSourceRole(source, "accent", "#00ff00");
    const colors = resolveThemeSource(edited, "dark");
    expect(themeColorToHex(colors.focus)).toBe("#ff0000");
    expect(themeColorToHex(colors.terminalCursor)).toBe("#00ff00");
    expect(themeColorToHex(colors.terminalBackground)).toBe("#002200");
    expect(themeColorToHex(colors.sidebarForeground)).toBe("#abcdef");
    expect(
      themeColorToHex(resolveThemeSource(setThemeSourceRole(edited, "focus", null), "dark").focus),
    ).toBe("#00ff00");
    expect(
      resolveThemeSource(parseThemeSource(JSON.parse(JSON.stringify(edited))), "dark"),
    ).toEqual(colors);
  });

  it("preserves every legacy color as explicit intent", () => {
    const colors = resolveThemeSource(
      { version: 2, seed: { canvas: "#fcfcfc", accent: "#ab1267" } },
      "light",
    );
    expect(resolveThemeSource(themeSourceFromColors(colors), "light")).toEqual(colors);
    const edited = setThemeSourceRole(themeSourceFromColors(colors), "accent", "#ff0000");
    expect(resolveThemeSource(edited, "light").focus).toBe(colors.focus);
  });
});
