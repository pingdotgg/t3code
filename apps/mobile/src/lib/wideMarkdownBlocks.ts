/**
 * Detects markdown that the JS renderer draws as a standalone block View
 * wrapping a horizontal ScrollView — fenced code blocks and GFM tables.
 *
 * Those blocks report an intrinsic width equal to their widest line, which is
 * effectively unbounded. A user bubble sizes itself from its content
 * (`maxWidth` with no `width`), so Android lays the bubble's children out
 * during the unclamped intrinsic pass — where the surrounding paragraphs
 * collapse to a single line — and never repositions them once the width is
 * clamped back to `maxWidth`. The result is siblings drawn on top of each
 * other inside an over-tall bubble. Pinning the bubble's width removes the
 * intrinsic pass entirely, which is the same reason review-comment bubbles
 * already carry an explicit width.
 *
 * Indented (four-space) code blocks are deliberately not detected: they are
 * vanishingly rare in chat input and the check would fire on ordinary nested
 * list continuations.
 */

const FENCED_CODE_BLOCK = /^ {0,3}(?:```|~~~)/m;

function isTableDelimiterRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) {
    return false;
  }
  return /^[|\-: \t]+$/.test(trimmed);
}

export function hasWideMarkdownBlock(text: string): boolean {
  if (FENCED_CODE_BLOCK.test(text)) {
    return true;
  }
  if (!text.includes("|")) {
    return false;
  }
  return text.split("\n").some(isTableDelimiterRow);
}
