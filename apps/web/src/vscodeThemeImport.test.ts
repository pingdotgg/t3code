import { describe, expect, it } from "vite-plus/test";

import { getThemeColorsForMode, themeColorToHex, THEME_FILE_VERSION } from "./themePalette";
import {
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseVsCodeThemeFile,
  resolveThemeLabelCollisions,
} from "./vscodeThemeImport";

function asHex(value: string): string {
  const hex = themeColorToHex(value);
  if (!hex) throw new Error(`Expected a theme color, received ${value}`);
  return hex;
}

function contrastRatio(first: string, second: string): number {
  const toChannels = (value: string) => {
    const hex = asHex(value).slice(1);
    return [0, 1, 2].map(
      (channel) => Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16) / 255,
    );
  };
  const luminance = (value: string) =>
    toChannels(value)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

// Shaped like a real workbench theme: dotted keys, alpha overlays, and a lot
// of roles simply left out.
const VSCODE_DARK = {
  name: "pierre-dark-soft",
  type: "dark",
  colors: {
    "editor.background": "#171717",
    "editor.foreground": "#d4d4d4",
    foreground: "#d4d4d4",
    "sideBar.background": "#101010",
    "sideBar.foreground": "#8a8a8a",
    "sideBar.border": "#1d1d1d",
    focusBorder: "#69b1ff",
    "button.background": "#69b1ff",
    "button.foreground": "#171717",
    "input.border": "#2c2c2c",
    "input.placeholderForeground": "#525252",
    "terminal.background": "#101010",
    "terminal.foreground": "#8a8a8a",
    "list.hoverBackground": "#1f3e5e59",
    "list.activeSelectionBackground": "#1f3e5e99",
  },
  tokenColors: [],
};

describe("VS Code theme import", () => {
  it("recognises workbench themes and rejects our own files", () => {
    expect(isVsCodeThemeFile(VSCODE_DARK)).toBe(true);
    expect(isVsCodeThemeFile({ type: "dark", tokenColors: [] })).toBe(true);
    expect(
      isVsCodeThemeFile({
        version: THEME_FILE_VERSION,
        name: "Aurora",
        appearance: "light",
        colors: { canvas: "#ffffff" },
      }),
    ).toBe(false);
    expect(isVsCodeThemeFile("nope")).toBe(false);
  });

  it("carries the editor surfaces and accent across", () => {
    const theme = parseVsCodeThemeFile(VSCODE_DARK);
    // The slug name is read as words; a displayName would win verbatim.
    expect(theme.label).toBe("Pierre Dark Soft");
    expect(theme.appearance).toBe("dark");
    expect(asHex(theme.colors.canvas)).toBe("#171717");
    expect(asHex(theme.colors.text)).toBe("#d4d4d4");
    expect(asHex(theme.colors.accent)).toBe("#69b1ff");
    expect(asHex(theme.colors.sidebar)).toBe("#101010");
    expect(asHex(theme.colors.terminalBackground)).toBe("#101010");
  });

  it("flattens alpha overlays onto the surface they sit on", () => {
    const theme = parseVsCodeThemeFile(VSCODE_DARK);
    // #1f3e5e59 over the #101010 sidebar, not left semi-transparent.
    expect(theme.colors.sidebarRowHover).toMatch(/^oklch\(/);
    expect(asHex(theme.colors.sidebarRowHover)).not.toBe("#1f3e5e59");
    expect(theme.colors.sidebarRowSelected).not.toBe(theme.colors.sidebar);
  });

  it("fills every role the file omits with a readable derived value", () => {
    const theme = parseVsCodeThemeFile(VSCODE_DARK);
    const colors = getThemeColorsForMode(theme, "dark")!;
    for (const value of Object.values(colors)) {
      expect(value).toMatch(/^oklch\(/);
    }
    expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.sidebarForeground, colors.sidebar)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(colors.messageActionForeground, colors.messageAction),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("falls back to the editor background when the type is missing or odd", () => {
    const untyped = parseVsCodeThemeFile({
      name: "Untyped",
      colors: { "editor.background": "#fdfdfd", "editor.foreground": "#202020" },
    });
    expect(untyped.appearance).toBe("light");
    const hc = parseVsCodeThemeFile({
      name: "High contrast",
      type: "hc-light",
      colors: { "editor.background": "#ffffff" },
    });
    expect(hc.appearance).toBe("light");
  });

  it("keeps an unreadable foreground out of the palette", () => {
    const theme = parseVsCodeThemeFile({
      name: "Unreadable",
      type: "dark",
      colors: { "editor.background": "#101010", "editor.foreground": "#111111" },
    });
    expect(asHex(theme.colors.text)).not.toBe("#111111");
    expect(contrastRatio(theme.colors.text, theme.colors.canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it("stays readable when the file replaces a surface but not its foreground", () => {
    // A dark theme with a light sidebar: the derived sidebar foreground was
    // solved for a dark surface and would vanish on this one.
    const theme = parseVsCodeThemeFile({
      name: "Split",
      type: "dark",
      colors: {
        "editor.background": "#101010",
        "editor.foreground": "#f5f5f5",
        "sideBar.background": "#fafafa",
        "terminal.background": "#fbfbfb",
      },
    });
    expect(asHex(theme.colors.sidebar)).toBe("#fafafa");
    expect(
      contrastRatio(theme.colors.sidebarForeground, theme.colors.sidebar),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(theme.colors.terminalForeground, theme.colors.terminalBackground),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("reads wide-gamut color() notation", () => {
    // Themes authored for P3 displays (the shipped Pierre "vibrant" pair) use
    // this instead of hex.
    const theme = parseVsCodeThemeFile({
      name: "Vibrant",
      type: "dark",
      colors: {
        "editor.background": "color(display-p3 0.039216 0.039216 0.039216)",
        "editor.foreground": "color(display-p3 0.980392 0.980392 0.980392)",
        focusBorder: "color(display-p3 0.308664 0.645271 1.000000)",
        "editor.selectionBackground": "color(display-p3 0.308664 0.645271 1.000000 / 0.300000)",
      },
    });
    expect(asHex(theme.colors.canvas)).toMatch(/^#0[89ab]/);
    expect(asHex(theme.colors.text)).toMatch(/^#f[a-f0-9]/);
    // The P3 blue lands in sRGB blue, not black or a clipped grey.
    const accent = asHex(theme.colors.accent);
    const [red, green, blue] = [1, 3, 5].map((index) =>
      Number.parseInt(accent.slice(index, index + 2), 16),
    ) as [number, number, number];
    expect(blue).toBeGreaterThan(200);
    expect(blue).toBeGreaterThan(red);
    expect(green).toBeGreaterThan(red);
  });

  it("pairs light and dark files from one family into dual-mode themes", () => {
    const make = (name: string, type: "light" | "dark") =>
      parseVsCodeThemeFile({
        name,
        type,
        colors: {
          "editor.background": type === "dark" ? "#101014" : "#fdfdfd",
          "editor.foreground": type === "dark" ? "#e6e6e6" : "#1f1f1f",
          focusBorder: "#69b1ff",
        },
      });
    const themes = pairVsCodeThemes([
      make("github-dark", "dark"),
      make("github-light", "light"),
      make("github-dark-colorblind", "dark"),
      make("github-light-colorblind", "light"),
      make("github-dark-dimmed", "dark"),
    ]);

    const labels = themes.map((theme) => theme.label);
    expect(labels).toEqual(["Github", "Github Colorblind", "Github Dark Dimmed"]);
    const github = themes[0]!;
    expect(github.appearance).toBe("light");
    expect(getThemeColorsForMode(github, "dark")).not.toBeNull();
    expect(asHex(getThemeColorsForMode(github, "dark")!.canvas)).toBe("#101014");
    expect(asHex(github.colors.canvas)).toBe("#fdfdfd");
    // The unpaired dimmed variant stays a single dark theme.
    expect(getThemeColorsForMode(themes[2]!, "light")).toBeNull();
  });

  it("does not guess when a family is ambiguous", () => {
    const make = (name: string, type: "light" | "dark") =>
      parseVsCodeThemeFile({
        name,
        type,
        colors: { "editor.background": type === "dark" ? "#101014" : "#fdfdfd" },
      });
    const themes = pairVsCodeThemes([
      make("solar-dark", "dark"),
      make("solar-dark-soft", "dark"),
      make("solar-light", "light"),
    ]);
    // "solar-dark-soft" groups under its own key with no light partner, so
    // it keeps its full name; the remaining pair merges.
    expect(themes.map((theme) => theme.label).sort()).toEqual(["Solar", "Solar Dark Soft"]);
  });

  it("keeps derived surfaces neutral instead of washing them with the accent", () => {
    // A gray theme with a blue focusBorder: roles the file omits (code
    // surface, plain surfaces) must stay near the canvas, not turn blue.
    const theme = parseVsCodeThemeFile(VSCODE_DARK);
    const spread = (value: string) => {
      const hex = asHex(value);
      const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
      return Math.max(...channels) - Math.min(...channels);
    };
    expect(spread(theme.colors.codeBackground)).toBeLessThanOrEqual(8);
    expect(spread(theme.colors.surface)).toBeLessThanOrEqual(8);
    expect(spread(theme.colors.text)).toBeLessThanOrEqual(12);
    // The accent itself keeps the file's color.
    expect(asHex(theme.colors.accent)).toBe("#69b1ff");
  });

  it("tells same-named variants apart by their file names", () => {
    // Dracula ships dracula.json and dracula-soft.json that both say
    // "Dracula" inside.
    const dracula = (bg: string) =>
      parseVsCodeThemeFile({
        name: "Dracula",
        type: "dark",
        colors: { "editor.background": bg, "editor.foreground": "#f8f8f2" },
      });
    const themes = resolveThemeLabelCollisions([
      { theme: dracula("#282a36"), sourceName: "dracula.json" },
      { theme: dracula("#22232e"), sourceName: "dracula-soft.json" },
    ]);
    expect(themes.map((theme) => theme.label)).toEqual(["Dracula", "Dracula Soft"]);
    expect(themes.map((theme) => theme.id)).toEqual(["dracula", "dracula-soft"]);
    // Without file names the second falls back to numbering.
    const numbered = resolveThemeLabelCollisions([
      { theme: dracula("#282a36") },
      { theme: dracula("#22232e") },
    ]);
    expect(numbered.map((theme) => theme.label)).toEqual(["Dracula", "Dracula 2"]);
  });

  it("falls back to the name when the displayName humanizes to nothing", () => {
    const theme = parseVsCodeThemeFile({
      displayName: "---",
      name: "night-owl",
      type: "dark",
      colors: { "editor.background": "#011627" },
    });
    expect(theme.label).toBe("Night Owl");
  });

  it("keeps a pair whose stripped name is reserved as two single themes", () => {
    const make = (name: string, type: "light" | "dark") =>
      parseVsCodeThemeFile({
        name,
        type,
        colors: { "editor.background": type === "dark" ? "#101014" : "#fdfdfd" },
      });
    const themes = pairVsCodeThemes([make("grove-light", "light"), make("grove-dark", "dark")]);
    expect(themes.map((theme) => theme.label).sort()).toEqual(["Grove Dark", "Grove Light"]);
  });

  it("explains a file with no editor background", () => {
    expect(() => parseVsCodeThemeFile({ name: "Empty", type: "dark", colors: {} })).toThrow(
      /editor\.background/,
    );
  });
});
