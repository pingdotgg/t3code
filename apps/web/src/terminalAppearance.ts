import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "@t3tools/contracts";

export { DEFAULT_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE };

/**
 * Wrap a family name in a CSS string so a face containing a comma, a leading
 * digit, or a reserved keyword cannot change the meaning of the font list it is
 * spliced into. The Ghostty surface appends its glyph fallbacks after whatever
 * it is handed and does not quote, so quoting has to happen here.
 */
export function quoteTerminalFontFamily(fontFamily: string): string {
  const escaped = fontFamily
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\r\n\f]/g, " ");
  return `"${escaped}"`;
}

export function normalizeTerminalFontSize(fontSize: number): number {
  if (!Number.isFinite(fontSize)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(fontSize)));
}

export function normalizeTerminalFontFamilyInput(fontFamily: string): string {
  return fontFamily.trim();
}

export function normalizeTerminalFontSizeInput(fontSize: string): number {
  const normalized = fontSize.trim();
  return normalizeTerminalFontSize(
    normalized.length === 0 ? DEFAULT_TERMINAL_FONT_SIZE : Number(normalized),
  );
}
