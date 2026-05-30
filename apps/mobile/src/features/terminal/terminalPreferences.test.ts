import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  normalizeTerminalFontSize,
} from "./terminalPreferences";

describe("normalizeTerminalFontSize", () => {
  it("returns the default size for missing or invalid values", () => {
    expect(normalizeTerminalFontSize(undefined)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(normalizeTerminalFontSize(null)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(normalizeTerminalFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("clamps below the minimum", () => {
    expect(normalizeTerminalFontSize(MIN_TERMINAL_FONT_SIZE - 4)).toBe(MIN_TERMINAL_FONT_SIZE);
  });

  it("clamps above the maximum", () => {
    expect(normalizeTerminalFontSize(MAX_TERMINAL_FONT_SIZE + 4)).toBe(MAX_TERMINAL_FONT_SIZE);
  });

  it("preserves in-range values", () => {
    expect(normalizeTerminalFontSize(9.5)).toBe(9.5);
  });
});
