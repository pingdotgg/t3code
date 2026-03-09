import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_FONT_FAMILIES,
  getAppFontOptions,
  normalizeAppFontSetting,
  normalizeSystemFontFamilies,
} from "./appFonts";

describe("normalizeAppFontSetting", () => {
  it("trims stored values and falls back when blank", () => {
    expect(normalizeAppFontSetting("interfaceFontFamily", '  "Avenir Next", sans-serif  ')).toBe(
      '"Avenir Next", sans-serif',
    );
    expect(normalizeAppFontSetting("interfaceFontFamily", "   ")).toBe(
      DEFAULT_APP_FONT_FAMILIES.interfaceFontFamily,
    );
  });
});

describe("normalizeSystemFontFamilies", () => {
  it("deduplicates and sorts families", () => {
    expect(
      normalizeSystemFontFamilies([" Menlo ", "SF Pro", "Menlo", "", null, "Avenir Next"]),
    ).toEqual(["Avenir Next", "Menlo", "SF Pro"]);
  });
});

describe("getAppFontOptions", () => {
  it("includes built-in presets and requested system font families", () => {
    const options = getAppFontOptions("headingFontFamily", ["Avenir Next"], null);

    expect(options.map((option) => option.label)).toEqual([
      "T3 Code Sans",
      "System UI",
      "Avenir Next",
    ]);
    expect(options.at(-1)?.value).toContain('"Avenir Next"');
  });

  it("keeps an existing selection visible even if it is not in the current option list", () => {
    const options = getAppFontOptions(
      "monoFontFamily",
      [],
      '"JetBrains Mono", "SF Mono", monospace',
    );

    expect(options.at(-1)).toMatchObject({
      label: "JetBrains Mono",
      source: "current",
      value: '"JetBrains Mono", "SF Mono", monospace',
    });
  });
});
