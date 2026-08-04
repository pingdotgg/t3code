import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TERMINAL_FONT_SIZE,
  normalizeTerminalFontFamilyInput,
  normalizeTerminalFontSize,
  normalizeTerminalFontSizeInput,
  quoteTerminalFontFamily,
} from "./terminalAppearance";

describe("quoteTerminalFontFamily", () => {
  it("escapes the characters that would otherwise end the CSS string", () => {
    expect(quoteTerminalFontFamily("MesloLGS NF")).toBe('"MesloLGS NF"');
    expect(quoteTerminalFontFamily('My "Nerd" \\ Font')).toBe('"My \\"Nerd\\" \\\\ Font"');
  });

  it("keeps a family containing a comma from splitting the font list", () => {
    // Unquoted, this would read as two families and silently change the stack.
    expect(quoteTerminalFontFamily("Comma, Face")).toBe('"Comma, Face"');
  });

  it("flattens newlines that would terminate the declaration", () => {
    expect(quoteTerminalFontFamily("Line\nBreak")).toBe('"Line Break"');
  });
});

describe("normalizeTerminalFontSize", () => {
  it("rounds, clamps, and falls back for invalid input", () => {
    expect(normalizeTerminalFontSize(14)).toBe(14);
    expect(normalizeTerminalFontSize(14.6)).toBe(15);
    expect(normalizeTerminalFontSize(2)).toBe(8);
    expect(normalizeTerminalFontSize(80)).toBe(32);
    expect(normalizeTerminalFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("normalizes values committed by the settings inputs", () => {
    expect(normalizeTerminalFontFamilyInput("  MesloLGS NF  ")).toBe("MesloLGS NF");
    expect(normalizeTerminalFontFamilyInput("   ")).toBe("");
    expect(normalizeTerminalFontSizeInput("")).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(normalizeTerminalFontSizeInput("  ")).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(normalizeTerminalFontSizeInput("14.6")).toBe(15);
    expect(normalizeTerminalFontSizeInput("2")).toBe(8);
    expect(normalizeTerminalFontSizeInput("80")).toBe(32);
    expect(normalizeTerminalFontSizeInput("not-a-number")).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });
});
