import { isMonospaceFamily } from "../../appearanceFonts";
import symbolsFontUrl from "./fonts/SymbolsNerdFontMono-Regular.woff2?url";

export const DEFAULT_TERMINAL_FONT_SIZE = 12;
export const MIN_TERMINAL_FONT_SIZE = 6;
export const MAX_TERMINAL_FONT_SIZE = 32;
export const TERMINAL_GLYPH_FALLBACKS =
  '"Symbols Nerd Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font", ' +
  '"JetBrainsMono NF", "FiraCode Nerd Font", "Hack Nerd Font", "MesloLGS NF", ' +
  '"CaskaydiaCove Nerd Font", "PowerlineSymbols", monospace';
// The platform's own monospace faces; concrete names only, because an
// unknown keyword (like ui-monospace) makes canvas font shorthand parsing
// reject the whole string.
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", ' + TERMINAL_GLYPH_FALLBACKS;
export const TERMINAL_FONT_LOAD_TEXT = "iMW0@# .";
export const TERMINAL_FONT_LOAD_VARIANTS = [
  "normal 400",
  "normal 700",
  "italic 400",
  "italic 700",
] as const;

export interface GhosttyTerminalFont {
  readonly family?: string;
  readonly size?: number;
}

export let symbolsFontLoad: Promise<void> | null = null;

export function ensureTerminalSymbolsFont(): Promise<void> {
  if (symbolsFontLoad !== null) return symbolsFontLoad;
  symbolsFontLoad = (async () => {
    try {
      const face = new FontFace("Symbols Nerd Font Mono", `url(${symbolsFontUrl})`);
      document.fonts.add(await face.load());
    } catch {}
  })();
  return symbolsFontLoad;
}

export function quoteTerminalFontFamilies(list: string): string {
  return list
    .split(",")
    .map((name) => {
      const bare = name.trim();
      if (bare.length === 0) return "";
      if (/^(['"]).*\1$/.test(bare)) return bare;
      if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
      return `"${bare.replaceAll('"', "")}"`;
    })
    .filter((name) => name.length > 0)
    .join(", ");
}

export function uncheckedTerminalFontFamily(family?: string): string {
  const custom = family === undefined ? "" : quoteTerminalFontFamilies(family);
  return custom.length === 0
    ? DEFAULT_TERMINAL_FONT_FAMILY
    : `${custom}, ${TERMINAL_GLYPH_FALLBACKS}`;
}

export function terminalFontFamily(family?: string): string {
  // Quote non-ident names ("3270 Nerd Font", "M+ 1m"): an unquoted one makes
  // the whole canvas font string invalid and the assignment silently no-ops.
  const custom = family === undefined ? "" : quoteTerminalFontFamilies(family);
  if (custom.length === 0) return DEFAULT_TERMINAL_FONT_FAMILY;
  if (!isMonospaceFamily(custom)) return DEFAULT_TERMINAL_FONT_FAMILY;
  return uncheckedTerminalFontFamily(custom);
}

export async function loadTerminalFontFamily(
  family: string | undefined,
  size: number,
  environment?: {
    readonly load: (font: string, text: string) => Promise<unknown>;
    readonly resolve: (family: string | undefined) => string;
  },
): Promise<string> {
  const candidate = uncheckedTerminalFontFamily(family);
  const load =
    environment?.load ?? ((font: string, text: string) => document.fonts.load(font, text));
  try {
    await Promise.all(
      TERMINAL_FONT_LOAD_VARIANTS.map((variant) =>
        load(`${variant} ${size}px ${candidate}`, TERMINAL_FONT_LOAD_TEXT),
      ),
    );
  } catch {}
  return (environment?.resolve ?? terminalFontFamily)(family);
}

export function terminalFontSize(size?: number): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(size)));
}

export function shouldBlinkTerminalCursor(state: {
  readonly focused: boolean;
  readonly cursorBlinking: boolean;
  readonly cursorVisible: boolean;
  readonly reducedMotion: boolean;
}): boolean {
  return state.focused && state.cursorBlinking && state.cursorVisible && !state.reducedMotion;
}
