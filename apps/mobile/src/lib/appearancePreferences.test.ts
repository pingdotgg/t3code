import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_BASE_FONT_SIZE,
  deriveCodeFontSize,
  deriveTerminalFontSize,
  normalizeBaseFontSize,
  normalizeCodeFontSize,
  normalizeCodeWordBreak,
  resolveAppearance,
  resolveAppearancePreferences,
  resolveMarkdownFontSizes,
  resolveMobileCodeSurface,
  resolveNativeMarkdownTypography,
  resolveTextScaleVariables,
  stepBaseFontSize,
  stepCodeFontSize,
  stepTerminalFontSize,
} from "./appearancePreferences";

describe("appearancePreferences", () => {
  it("resolves defaults for empty stored preferences", () => {
    expect(resolveAppearancePreferences({})).toEqual({
      baseFontSize: DEFAULT_BASE_FONT_SIZE,
      terminalFontSize: null,
      codeFontSize: null,
      codeWordBreak: false,
    });
  });

  it("migrates the legacy markdownFontSize key to baseFontSize", () => {
    expect(resolveAppearancePreferences({ markdownFontSize: 18 }).baseFontSize).toBe(18);
    expect(
      resolveAppearancePreferences({ baseFontSize: 16, markdownFontSize: 18 }).baseFontSize,
    ).toBe(16);
  });

  it("keeps explicit overrides and treats missing values as automatic", () => {
    const preferences = resolveAppearancePreferences({ terminalFontSize: 12, codeFontSize: 14 });
    expect(preferences.terminalFontSize).toBe(12);
    expect(preferences.codeFontSize).toBe(14);
    expect(resolveAppearancePreferences({ terminalFontSize: null }).terminalFontSize).toBe(null);
  });

  it("derives terminal and code sizes from the base size when not overridden", () => {
    const appearance = resolveAppearance(resolveAppearancePreferences({ baseFontSize: 15 }));
    expect(appearance.terminalFontSize).toBe(10);
    expect(appearance.codeFontSize).toBe(11);
    expect(appearance.isTerminalFontSizeCustom).toBe(false);
    expect(appearance.isCodeFontSizeCustom).toBe(false);

    const scaled = resolveAppearance(resolveAppearancePreferences({ baseFontSize: 22 }));
    expect(scaled.terminalFontSize).toBe(deriveTerminalFontSize(22));
    expect(scaled.codeFontSize).toBe(deriveCodeFontSize(22));
    expect(scaled.terminalFontSize).toBeGreaterThan(10);
    expect(scaled.codeFontSize).toBeGreaterThan(11);
  });

  it("applies explicit overrides over derived values", () => {
    const appearance = resolveAppearance(
      resolveAppearancePreferences({ baseFontSize: 22, terminalFontSize: 8, codeFontSize: 9 }),
    );
    expect(appearance.terminalFontSize).toBe(8);
    expect(appearance.codeFontSize).toBe(9);
    expect(appearance.isTerminalFontSizeCustom).toBe(true);
    expect(appearance.isCodeFontSizeCustom).toBe(true);
  });

  it("clamps base and code font sizes", () => {
    expect(normalizeBaseFontSize(4)).toBe(11);
    expect(normalizeBaseFontSize(30)).toBe(22);
    expect(normalizeCodeFontSize(4)).toBe(8);
    expect(normalizeCodeFontSize(30)).toBe(18);
  });

  it("steps font sizes within bounds", () => {
    expect(stepTerminalFontSize(6, -1)).toBe(6);
    expect(stepBaseFontSize(11, -1)).toBe(11);
    expect(stepCodeFontSize(8, -1)).toBe(8);
    expect(stepBaseFontSize(15, 1)).toBe(16);
  });

  it("scales markdown typography from the base size", () => {
    expect(resolveMarkdownFontSizes(15)).toMatchObject({
      m: 15,
      h1: 20,
      bodyLineHeight: 22,
      codeBlockFontSize: 12,
      codeBlockLineHeight: 18,
    });
  });

  it("scales code surface geometry from the code font size", () => {
    expect(resolveMobileCodeSurface(11)).toMatchObject({
      fontSize: 11,
      rowHeight: 20,
    });
  });

  it("defaults code word break to false", () => {
    expect(normalizeCodeWordBreak(undefined)).toBe(false);
    expect(normalizeCodeWordBreak(true)).toBe(true);
  });

  it("returns the authored text scale at the 16pt default", () => {
    expect(DEFAULT_BASE_FONT_SIZE).toBe(16);

    const variables = resolveTextScaleVariables(DEFAULT_BASE_FONT_SIZE);
    expect(variables["--text-base"]).toBe(16);
    expect(variables["--text-base--line-height"]).toBe(23);
    expect(variables["--text-sm"]).toBe(14);
    expect(variables["--text-sm--line-height"]).toBe(19);
    expect(variables["--text-lg"]).toBe(18);
    expect(variables["--text-3xl"]).toBe(30);
  });

  it("scales every text variable proportionally with the base size", () => {
    const smallerVariables = resolveTextScaleVariables(15);
    expect(smallerVariables["--text-base"]).toBe(15);
    expect(smallerVariables["--text-sm"]).toBe(13);

    const variables = resolveTextScaleVariables(20);
    expect(variables["--text-base"]).toBe(20);
    expect(variables["--text-base--line-height"]).toBe(29);
    expect(variables["--text-sm"]).toBe(18);
    expect(variables["--text-xs"]).toBe(16);
    expect(variables["--text-lg"]).toBe(23);

    const smaller = resolveTextScaleVariables(11);
    expect(smaller["--text-base"]).toBe(11);
    expect(smaller["--text-3xs"]).toBeGreaterThanOrEqual(8);
    expect(smaller["--text-3xs--line-height"]).toBeGreaterThanOrEqual(10);
  });

  it("derives native markdown typography from the base size", () => {
    expect(resolveNativeMarkdownTypography(22)).toEqual({
      fontSize: 22,
      lineHeight: 32,
      headingFontSizes: [29, 26, 23, 21, 21, 21],
    });
  });
});
