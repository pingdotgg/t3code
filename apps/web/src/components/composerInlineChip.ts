export const SKILL_CHIP_ICON_SVG = `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;

const attachmentNameSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const EMOJI_GRAPHEME = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
const WIDE_GRAPHEME =
  /^[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;

// Rendered width in average Latin glyphs of the chip font, so the budget matches its max-w-72 label.
function attachmentGraphemeWidth(grapheme: string): number {
  if (EMOJI_GRAPHEME.test(grapheme)) return 2.3;
  if (WIDE_GRAPHEME.test(grapheme)) return 1.75;
  return 1;
}

export function middleTruncateAttachmentName(name: string, maxWidth = 36): string {
  const graphemes = Array.from(attachmentNameSegmenter.segment(name), (part) => part.segment);
  const widths = graphemes.map(attachmentGraphemeWidth);
  if (widths.reduce((total, width) => total + width, 0) <= maxWidth) return name;
  if (maxWidth <= 0) return "";
  if (maxWidth === 1) return "…";
  const available = maxWidth - 1;
  const suffixBudget = Math.min(available - 1, available >= 18 ? 14 : Math.ceil(available / 2));
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
