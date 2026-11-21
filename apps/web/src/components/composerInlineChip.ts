export const SKILL_CHIP_ICON_SVG = `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;

const attachmentNameSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Chip labels are 14px medium text capped at max-w-72 (288px); 8px is an average Latin glyph.
const LABEL_WIDTH = 288;
const AVERAGE_GLYPH_WIDTH = 8;
let measureContext: CanvasRenderingContext2D | null | undefined;

function attachmentNameMeasure(): (text: string) => number {
  measureContext ??=
    typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  const context = measureContext;
  if (!context) return () => AVERAGE_GLYPH_WIDTH;
  const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-sans");
  context.font = `500 14px ${fontFamily || "sans-serif"}`;
  return (text) => context.measureText(text).width;
}

export function middleTruncateAttachmentName(name: string): string {
  const measure = attachmentNameMeasure();
  const graphemes = Array.from(attachmentNameSegmenter.segment(name), (part) => part.segment);
  const widths = graphemes.map(measure);
  if (widths.reduce((total, width) => total + width, 0) <= LABEL_WIDTH) return name;
  const available = LABEL_WIDTH - measure("…");
  const suffixBudget = 14 * AVERAGE_GLYPH_WIDTH;
  const prefixBudget = available - suffixBudget;
  let suffixStart = graphemes.length;
  let suffixWidth = 0;
  while (suffixStart > 0 && suffixWidth + widths[suffixStart - 1]! <= suffixBudget) {
    suffixWidth += widths[--suffixStart]!;
  }
  let prefixEnd = 0;
  let prefixWidth = 0;
  while (prefixEnd < suffixStart && prefixWidth + widths[prefixEnd]! <= prefixBudget) {
    prefixWidth += widths[prefixEnd++]!;
  }
  return `${graphemes.slice(0, prefixEnd).join("")}…${graphemes.slice(suffixStart).join("")}`;
}
