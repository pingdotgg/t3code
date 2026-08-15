import { describe, expect, it } from "vite-plus/test";

import {
  addImportedMobileTheme,
  MAX_IMPORTED_MOBILE_THEMES,
  MAX_IMPORTED_MOBILE_THEMES_BYTES,
  MAX_MOBILE_THEME_FILE_BYTES,
  parseMobileThemeFile,
  parseMobileThemeFileJson,
  sanitizeImportedMobileThemes,
} from "./mobileThemeFile";

function themeFile(id = "northern-lights") {
  return {
    version: 1,
    id,
    name: "Northern Lights",
    appearance: "light",
    colors: {
      canvas: "#f1f5f9",
      text: "rgb(15 23 42)",
      accent: "oklch(0.62 0.2 280)",
      terminalCursor: "hsl(210 90% 55%)",
    },
    variants: {
      dark: {
        canvas: "#0f172a",
        text: "#f8fafc",
        accent: "#60a5fa",
      },
    },
  } as const;
}

describe("parseMobileThemeFile", () => {
  it("accepts and normalizes a portable ThemeFile v1", () => {
    expect(parseMobileThemeFile(themeFile())).toMatchObject({
      version: 1,
      id: "northern-lights",
      name: "Northern Lights",
      appearance: "light",
      colors: {
        canvas: "#f1f5f9",
        text: "#0f172a",
        accent: expect.stringMatching(/^#[\da-f]{6}$/),
        terminalCursor: expect.stringMatching(/^#[\da-f]{6}$/),
      },
      variants: {
        dark: {
          canvas: "#0f172a",
          text: "#f8fafc",
          accent: "#60a5fa",
        },
      },
    });
  });

  it("normalizes supported CSS literals to RN-safe hex without dropping alpha", () => {
    const parsed = parseMobileThemeFile({
      ...themeFile(),
      colors: {
        canvas: "#abc",
        surface: "rgb(100% 0% 50% / 25%)",
        text: "aliceblue",
        border: "transparent",
        accent: "hsl(120 100% 25% / 50%)",
        terminalCursor: "oklch(100% 0 0 / 50%)",
      },
    });

    expect(parsed.colors).toEqual({
      canvas: "#aabbcc",
      surface: "#ff008040",
      text: "#f0f8ff",
      border: "#00000000",
      accent: "#00800080",
      terminalCursor: "#ffffff80",
    });
  });

  it.each([
    { input: "rgb(none 20 30)", expected: "#00141e" },
    { input: "rgb(255 0 0 / 200%)", expected: "#ff0000" },
  ])("normalizes CSS RGB edge case $input", ({ input, expected }) => {
    const parsed = parseMobileThemeFile({ ...themeFile(), colors: { canvas: input } });

    expect(parsed.colors.canvas).toBe(expected);
  });

  it.each([
    { input: "hsl(none 0% 50%)", expected: "#808080" },
    { input: "hsl(120 none none)", expected: "#000000" },
  ])("matches web missing HSL component semantics for $input", ({ input, expected }) => {
    const parsed = parseMobileThemeFile({ ...themeFile(), colors: { canvas: input } });

    expect(parsed.colors.canvas).toBe(expected);
  });

  it.each([
    { format: "hwb typical", input: "hwb(45 10% 20%)", expected: "#cc9f1a" },
    { format: "hwb with alpha", input: "hwb(200 10% 20% / 40%)", expected: "#1991cc66" },
    { format: "hwb normalized edge", input: "hwb(30 80% 70%)", expected: "#888888" },
    { format: "lab typical", input: "lab(60% 40 30)", expected: "#d9725e" },
    { format: "lab with alpha", input: "lab(70% -20 40 / 25%)", expected: "#99b55f40" },
    { format: "lab out of gamut", input: "lab(60% 100 100)", expected: "#ff574a" },
    { format: "lch typical", input: "lch(60% 50 120)", expected: "#769c3e" },
    { format: "lch with alpha", input: "lch(70% 40 250 / 25%)", expected: "#60b5ef40" },
    { format: "lch out of gamut", input: "lch(60% 150 40)", expected: "#ff5a5b" },
    { format: "oklab typical", input: "oklab(0.6 0.1 -0.1)", expected: "#9f63ba" },
    {
      format: "oklab with alpha",
      input: "oklab(70% -0.1 0.1 / 25%)",
      expected: "#77b25340",
    },
    { format: "oklab out of gamut", input: "oklab(0.7 0.4 0.4)", expected: "#fe6a00" },
    {
      format: "display-p3 typical",
      input: "color(display-p3 0.8 0.2 0.3)",
      expected: "#de1849",
    },
    {
      format: "display-p3 with alpha",
      input: "color(display-p3 0.2 0.7 0.4 / 40%)",
      expected: "#00b16966",
    },
    {
      format: "display-p3 out of gamut",
      input: "color(display-p3 1 0 0)",
      expected: "#ff3428",
    },
    {
      format: "srgb typical",
      input: "color(srgb 0.2 0.4 0.8)",
      expected: "#3366cc",
    },
    {
      format: "srgb with alpha",
      input: "color(srgb 0.2 0.7 0.4 / 40%)",
      expected: "#33b36666",
    },
    {
      format: "srgb out of gamut",
      input: "color(srgb 1.2 -0.1 0.5)",
      expected: "#ff7391",
    },
  ])("matches web canonicalization for $format", ({ input, expected }) => {
    const parsed = parseMobileThemeFile({ ...themeFile(), colors: { canvas: input } });

    expect(parsed.colors.canvas).toBe(expected);
  });

  it("rejects unsupported versions", () => {
    expect(() => parseMobileThemeFile({ ...themeFile(), version: 2 })).toThrow(
      "unsupported version",
    );
  });

  it("rejects invalid ids", () => {
    expect(() => parseMobileThemeFile({ ...themeFile(), id: "Not Valid" })).toThrow(
      "lowercase letters, numbers, and hyphens",
    );
  });

  it("enforces id, name, appearance, and colors-object boundaries", () => {
    expect(parseMobileThemeFile({ ...themeFile(), id: "a".repeat(48) }).id).toBe("a".repeat(48));
    expect(() => parseMobileThemeFile({ ...themeFile(), id: "a".repeat(49) })).toThrow("Theme ids");
    expect(() => parseMobileThemeFile({ ...themeFile(), name: " " })).toThrow("need a name");
    expect(() => parseMobileThemeFile({ ...themeFile(), name: "a".repeat(49) })).toThrow(
      "48 characters",
    );
    expect(() => parseMobileThemeFile({ ...themeFile(), appearance: "system" })).toThrow(
      '"light" or "dark"',
    );
    expect(() => parseMobileThemeFile({ ...themeFile(), colors: [] })).toThrow("colors object");
  });

  it("matches web id derivation when the name has no slug characters", () => {
    expect(parseMobileThemeFile({ ...themeFile(), id: undefined, name: "✨" }).id).toBe(
      "custom-theme",
    );
  });

  it("suffixes a reserved id derived from the theme name", () => {
    expect(parseMobileThemeFile({ ...themeFile(), id: undefined, name: "T3 Code" }).id).toBe(
      "t3-code-2",
    );
  });

  it.each([
    "var(--color-screen)",
    "color-mix(in srgb, red, blue)",
    "color(rec2020 1 0 0)",
    "hwb(1.e2 10% 20%)",
    "lab(50% 1. 30)",
    "color(srgb 1. .3 .4)",
    "oklab(0.7 1e308 -1e308)",
    "oklch(0.7 1e308 0)",
  ])('rejects the unsupported color syntax "%s" with a role-specific error', (color) => {
    expect(() => parseMobileThemeFile({ ...themeFile(), colors: { canvas: color } })).toThrow(
      `The color "${color}" for "canvas" is not supported.`,
    );
  });

  it.each([
    "hwb(30 20% 30% /)",
    "lab(60% 20 30 /)",
    "lch(60% 40 30 /)",
    "oklab(0.6 0.1 0.1 /)",
    "oklch(0.6 0.1 30 /)",
    "color(display-p3 0.2 0.3 0.4 /)",
    "color(srgb 0.2 0.3 0.4 /)",
  ])('rejects the missing alpha component in "%s"', (color) => {
    expect(() => parseMobileThemeFile({ ...themeFile(), colors: { canvas: color } })).toThrow(
      `The color "${color}" for "canvas" is not supported.`,
    );
  });

  it.each(["__proto__", "constructor"])(
    'rejects the prototype-inherited named color "%s"',
    (color) => {
      expect(() => parseMobileThemeFile({ ...themeFile(), colors: { canvas: color } })).toThrow(
        `The color "${color}" for "canvas" is not supported.`,
      );
    },
  );

  it("rejects oversized pasted files before parsing", () => {
    const source = `${JSON.stringify(themeFile())}${" ".repeat(MAX_MOBILE_THEME_FILE_BYTES)}`;
    expect(() => parseMobileThemeFileJson(source)).toThrow("64 KB or smaller");
  });
});

describe("addImportedMobileTheme", () => {
  it("deliberately rejects a duplicate id without reordering the library", () => {
    const installed = parseMobileThemeFile(themeFile());
    expect(() => addImportedMobileTheme([installed], installed)).toThrow("already installed");
  });

  it("rejects imports above the installed-theme count cap", () => {
    const installed = Array.from({ length: MAX_IMPORTED_MOBILE_THEMES }, (_, index) =>
      parseMobileThemeFile(themeFile(`theme-${index}`)),
    );

    expect(() =>
      addImportedMobileTheme(installed, parseMobileThemeFile(themeFile("one-too-many"))),
    ).toThrow(`up to ${MAX_IMPORTED_MOBILE_THEMES} imported themes`);
  });

  it("rejects an imported library above the storage byte cap", () => {
    const oversized = {
      ...parseMobileThemeFile(themeFile()),
      metadata: "x".repeat(MAX_IMPORTED_MOBILE_THEMES_BYTES),
    };

    expect(() => addImportedMobileTheme([], oversized)).toThrow("256 KB");
  });
});

describe("sanitizeImportedMobileThemes", () => {
  it("keeps the first 20 themes at the installed-theme boundary", () => {
    const storedThemes = Array.from({ length: MAX_IMPORTED_MOBILE_THEMES + 1 }, (_, index) =>
      themeFile(`theme-${index}`),
    );

    expect(sanitizeImportedMobileThemes(storedThemes).map((theme) => theme.id)).toEqual(
      Array.from({ length: MAX_IMPORTED_MOBILE_THEMES }, (_, index) => `theme-${index}`),
    );
  });
});
