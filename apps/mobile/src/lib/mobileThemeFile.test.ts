import { describe, expect, it } from "vite-plus/test";

import {
  addImportedMobileTheme,
  MAX_IMPORTED_MOBILE_THEMES,
  MAX_MOBILE_THEME_FILE_BYTES,
  normalizeMobileThemeColorLiteral,
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
      accent: "oklch(0.62 0.2 280 / 50%)",
    },
    variants: {
      dark: {
        canvas: "#0f172a",
      },
    },
  } as const;
}

describe("mobile ThemeFile adapter", () => {
  it("stores the shared canonical representation and converts colors at the native boundary", () => {
    const parsed = parseMobileThemeFile(themeFile());

    expect(parsed).toMatchObject({
      id: "northern-lights",
      appearance: "light",
      colors: {
        canvas: expect.stringMatching(/^oklch\(/),
        text: expect.stringMatching(/^oklch\(/),
        accent: expect.stringMatching(/\/ 0\.5\)$/),
      },
    });
    expect(normalizeMobileThemeColorLiteral(parsed.colors.canvas ?? "")).toBe("#f1f5f9");
    expect(normalizeMobileThemeColorLiteral(parsed.colors.accent ?? "")).toMatch(/^#[\da-f]{8}$/);
  });

  it("rejects reserved derived ids instead of silently rewriting portable files", () => {
    expect(() => parseMobileThemeFile({ ...themeFile(), id: undefined, name: "T3 Code" })).toThrow(
      'theme id "t3-code" is reserved',
    );
  });

  it("rejects oversized pasted files before parsing", () => {
    const source = `${JSON.stringify(themeFile())}${" ".repeat(MAX_MOBILE_THEME_FILE_BYTES)}`;
    expect(() => parseMobileThemeFileJson(source)).toThrow("64 KB or smaller");
  });

  it("enforces the installed-theme limit", () => {
    const installed = Array.from({ length: MAX_IMPORTED_MOBILE_THEMES }, (_, index) =>
      parseMobileThemeFile(themeFile(`theme-${index}`)),
    );

    expect(() =>
      addImportedMobileTheme(installed, parseMobileThemeFile(themeFile("one-too-many"))),
    ).toThrow(`${MAX_IMPORTED_MOBILE_THEMES} imported themes`);
  });

  it("isolates invalid persisted entries", () => {
    const valid = themeFile("valid-theme");
    expect(sanitizeImportedMobileThemes([valid, themeFile("t3-code"), valid])).toEqual([
      parseMobileThemeFile(valid),
    ]);
  });
});
