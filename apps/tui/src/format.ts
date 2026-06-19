// Small text-formatting helpers shared across the TUI (mirrors the spirit of
// apps/web/src/timestampFormat.ts — pure, render-agnostic string utilities).

/** Truncate to `width` with a trailing ellipsis. */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}

/** Truncate then right-pad so a fixed trailing segment sits at the right edge. */
export function padClip(text: string, width: number): string {
  return clip(text, width).padEnd(Math.max(0, width));
}
