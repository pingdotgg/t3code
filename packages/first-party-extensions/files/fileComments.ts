/**
 * Review comments on file lines. The native panel
 * (FilePreviewPanel's EditableFileSurface) selects lines in a rich editor and
 * submits a draft annotation that lands in the composer draft store through
 * `buildFileReviewComment`. This package's editor is a plain `<textarea>`,
 * so the selection is a character range: it expands to the
 * full lines it touches, quotes those lines as the annotation excerpt, and
 * submits through the grant-gated `t3.messages/enrichment.attachAnnotation`
 * seam. Removal has no contract op — comments are removed from the composer
 * chip, and the in-view list says so.
 */

import { lineStartOffset } from "./fileNavigation.ts";

/** Plugin-side excerpt cap; the contract accepts more, the plugin names the truncation. */
export const COMMENT_EXCERPT_MAX_CHARS = 512;

export interface FileCommentRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** Min/max line pair — the native `normalizeFileCommentRange` normalization. */
export function normalizeCommentRange(startLine: number, endLine: number): FileCommentRange {
  return {
    startLine: Math.max(1, Math.min(startLine, endLine)),
    endLine: Math.max(1, Math.max(startLine, endLine)),
  };
}

/** Native range label (`formatFileCommentRange` / `buildFileReviewComment`): `L5` or `L5 to L9`. */
export function formatCommentRangeLabel(startLine: number, endLine: number): string {
  const range = normalizeCommentRange(startLine, endLine);
  return range.startLine === range.endLine
    ? `L${range.startLine}`
    : `L${range.startLine} to L${range.endLine}`;
}

/** 1-based line number containing 0-based character `offset`, clamped into the text. */
export function lineAtOffset(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let index = 0; index < clamped; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * The full lines a textarea character selection touches, or null for an empty
 * selection. A selection ending exactly at a line boundary belongs to the
 * previous line: the caret before a newline never selects the line after it.
 */
export function selectionLineRange(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): FileCommentRange | null {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd));
  const end = Math.min(text.length, Math.max(selectionStart, selectionEnd));
  if (start >= end) return null;
  return {
    startLine: lineAtOffset(text, start),
    endLine: lineAtOffset(text, end - 1),
  };
}

/** Character offset just past the last character of 1-based `line` (the newline excluded). */
function lineEndOffset(text: string, line: number): number {
  let current = 1;
  let offset = 0;
  while (current < line) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) return text.length;
    offset = newline + 1;
    current += 1;
  }
  const newline = text.indexOf("\n", offset);
  return newline === -1 ? text.length : newline;
}

/**
 * The excerpt an annotation quotes: the range's full lines joined, capped at
 * `maxChars` with `truncated` disclosed. The cut stays on a character
 * boundary — a trailing UTF-16 high surrogate would split a pair, so the cut
 * backs off one unit rather than emit a lone surrogate.
 */
export function buildCommentExcerpt(
  text: string,
  range: FileCommentRange,
  maxChars: number = COMMENT_EXCERPT_MAX_CHARS,
): { readonly excerpt: string; readonly truncated: boolean } {
  const normalized = normalizeCommentRange(range.startLine, range.endLine);
  const start = lineStartOffset(text, normalized.startLine);
  const end = lineEndOffset(text, normalized.endLine);
  const full = text.slice(start, end);
  if (full.length <= maxChars) return { excerpt: full, truncated: false };
  let cut = maxChars;
  const codeUnit = full.charCodeAt(cut - 1);
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) cut -= 1;
  return { excerpt: full.slice(0, cut), truncated: true };
}

export interface CommentTransportCapabilities {
  readonly transport: string;
  readonly detail: string | null;
  readonly operations: { readonly attachAnnotation?: boolean };
}

/**
 * Why commenting is unavailable, or null when the action can run. A
 * non-client transport names a host without a connected client; a missing
 * thread scope means this panel has no draft to write into. Grant denial is
 * not knowable here — it surfaces as the invoke's named error at submit.
 */
export function commentUnavailableReason(
  capabilities: CommentTransportCapabilities,
  threadId: string | undefined,
): string | null {
  if (threadId === undefined)
    return "This panel has no thread scope, so there is no draft to comment into.";
  if (capabilities.transport !== "client" || capabilities.operations.attachAnnotation !== true) {
    return (
      capabilities.detail ?? "Commenting needs a connected client hosting the composer provider."
    );
  }
  return null;
}
