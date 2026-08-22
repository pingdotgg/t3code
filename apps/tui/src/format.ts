// Small text-formatting helpers shared across the TUI (mirrors the spirit of
// apps/web/src/timestampFormat.ts — pure, render-agnostic string utilities).

/**
 * Truncate to `width` display columns (not code units — CJK and emoji occupy
 * two columns) with a trailing ellipsis, never splitting a surrogate pair.
 */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(text) <= width) return text;
  let clipped = "";
  let used = 0;
  for (const character of text) {
    const characterWidth = Bun.stringWidth(character);
    if (used + characterWidth > width - 1) break;
    clipped += character;
    used += characterWidth;
  }
  return `${clipped}…`;
}

/** Truncate then right-pad so a fixed trailing segment sits at the right edge. */
export function padClip(text: string, width: number): string {
  const clipped = clip(text, width);
  return clipped + " ".repeat(Math.max(0, width - Bun.stringWidth(clipped)));
}
