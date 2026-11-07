import { describe, expect, it } from "vite-plus/test";
import {
  setThemeSourceRole,
  parseThemeSource,
  resolveThemeSource,
  themeColorToHex,
  themeSourceFromColors,
  themeSourceForEditing,
} from "./themeResolution.ts";

describe("authored theme resolution", () => {
  it("inherits family changes while preserving explicit colors until reset", () => {
    const source = parseThemeSource({
      version: 2,
      seed: { canvas: "#101010", accent: "#123456" },
      overrides: { focus: "#ff0000", terminalBackground: "#002200", sidebarForeground: "#abcdef" },
    });
    expect(resolveThemeSource(source, "dark")).toMatchInlineSnapshot(`
      {
        "accent": "oklch(0.319168 0.072455 251.168)",
        "accentForeground": "oklch(0.990339 0.008411 325.64)",
        "accentSurface": "oklch(0.303042 0.03985 251.168)",
        "accentSurfaceForeground": "oklch(0.95 0.018114 251.168)",
        "border": "oklch(0.333042 0.025359 251.168)",
        "canvas": "oklch(0.173042 0 0)",
        "chrome": "oklch(0.173042 0 0)",
        "codeBackground": "oklch(0.208042 0.012752 251.168)",
        "codeForeground": "oklch(0.950853 0.01829 250.591)",
        "error": "oklch(0.655108 0.221148 23.473)",
        "errorForeground": "oklch(0.702184 0.189226 22.228)",
        "errorSurface": "oklch(0.251919 0.047566 18.015)",
        "focus": "oklch(0.627955 0.257683 29.234)",
        "iconMuted": "oklch(0.612837 0.010624 250.575)",
        "input": "oklch(0.383042 0.028982 251.168)",
        "messageAction": "oklch(0.37984 0.063821 300.819)",
        "messageActionForeground": "oklch(0.990339 0.008411 325.64)",
        "messageActionHover": "oklch(0.439168 0.065209 301.168)",
        "messageForeground": "oklch(0.95 0.018114 251.168)",
        "messageSurface": "oklch(0.333042 0.043473 251.168)",
        "muted": "oklch(0.233042 0.025359 251.168)",
        "mutedForeground": "oklch(0.6207 0.01974 249.459)",
        "placeholder": "oklch(0.613802 0.016545 251.25)",
        "searchMatchActiveBackground": "oklch(0.572405 0.072569 251.769)",
        "searchMatchActiveForeground": "oklch(0 0 0)",
        "searchMatchBackground": "oklch(0.393188 0.071826 250.735)",
        "searchMatchForeground": "oklch(0.990339 0.008411 325.64)",
        "secondary": "oklch(0.273042 0.036227 251.168)",
        "secondaryForeground": "oklch(0.95 0.018114 251.168)",
        "secondaryLabel": "oklch(0.612837 0.010624 250.575)",
        "sidebar": "oklch(0.218042 0.022316 251.168)",
        "sidebarBorder": "oklch(0.343042 0.028982 251.168)",
        "sidebarControlSurface": "oklch(0.273042 0.02391 251.168)",
        "sidebarForeground": "oklch(0.834979 0.060153 248.55)",
        "sidebarMutedForeground": "oklch(0.635248 0.018769 249.58)",
        "sidebarRowActive": "oklch(0.293042 0.03985 251.168)",
        "sidebarRowHover": "oklch(0.253042 0.032605 251.168)",
        "sidebarRowSelected": "oklch(0.313042 0.043473 251.168)",
        "surface": "oklch(0.188042 0.01594 251.168)",
        "surfaceOverlay": "oklch(0.248042 0.01594 251.168)",
        "surfaceRaised": "oklch(0.223042 0.01594 251.168)",
        "terminalBackground": "oklch(0.218312 0.074286 142.495)",
        "terminalCursor": "oklch(0.319168 0.072455 251.168)",
        "terminalForeground": "oklch(0.990339 0.008411 325.64)",
        "terminalSelection": "oklch(0.250296 0.043595 169.193)",
        "text": "oklch(0.950853 0.01829 250.591)",
        "textMuted": "oklch(0.612837 0.010624 250.575)",
        "toolbar": "oklch(0.173042 0 0)",
        "toolbarBorder": "oklch(0.313042 0.028982 251.168)",
        "toolbarControl": "oklch(0.263042 0.020722 251.168)",
        "toolbarControlForeground": "oklch(0.950853 0.01829 250.591)",
        "toolbarControlHover": "oklch(0.313042 0.025504 251.168)",
        "toolbarForeground": "oklch(0.950853 0.01829 250.591)",
        "update": "oklch(0.319168 0.072455 251.168)",
        "updateForeground": "oklch(0.95 0.018114 251.168)",
        "updateSurface": "oklch(0.313042 0.03985 251.168)",
        "warning": "oklch(0.772406 0.172798 65.367)",
        "warningForeground": "oklch(0.829017 0.171221 81.038)",
        "warningSurface": "oklch(0.282132 0.044875 75.875)",
      }
    `);
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

  it("regenerates legacy guided themes while preserving explicit imported sources", () => {
    const colors = resolveThemeSource(
      { version: 2, seed: { canvas: "#101418", accent: "#123456" } },
      "dark",
    );
    const legacy = {
      id: "guided",
      label: "Guided",
      appearance: "dark" as const,
      colors,
      managed: true,
    };
    const source = themeSourceForEditing(legacy, "dark");
    expect(source.overrides).toBeUndefined();
    const edited = resolveThemeSource(
      { ...source, seed: { canvas: "#3a0d0d", accent: "#123456" } },
      "dark",
    );
    expect(themeColorToHex(edited.chrome)).toBe("#3a0d0d");
    expect(edited.surface).not.toBe(colors.surface);
    const imported = { ...legacy, sources: { dark: themeSourceFromColors(colors) } };
    expect(themeSourceForEditing(imported, "dark").overrides).toEqual(colors);
    expect(themeSourceForEditing({ ...legacy, managed: false }, "dark").overrides).toEqual(colors);
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
