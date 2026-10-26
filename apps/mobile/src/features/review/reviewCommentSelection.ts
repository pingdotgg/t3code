import { useSyncExternalStore } from "react";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import type { ReviewRenderableLineRow } from "./reviewModel";

export interface ReviewCommentTarget {
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface ReviewInlineComment {
  readonly id: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rangeLabel: string;
  readonly text: string;
  readonly diff: string;
  readonly fenceLanguage?: string;
}

export type ReviewCommentMessageSegment =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly kind: "review-comment";
      readonly comment: ReviewInlineComment;
    };

/** The first line of a range picked with a long press, waiting for its other end. */
export interface PendingReviewCommentRange extends Pick<
  ReviewCommentTarget,
  "sectionId" | "sectionTitle" | "filePath" | "lines"
> {
  readonly lineIndex: number;
  readonly rowId: string;
}

/** The sheet, thread and section a selection was made in, and the diff it was made over. */
export interface ReviewCommentSelectionScope {
  readonly key: string;
  /** Compared by `===`: a git section's diff hash, or a turn's diff as answered. */
  readonly content: string | null;
}

export interface ReviewCommentSelection {
  readonly scope: ReviewCommentSelectionScope | null;
  readonly target: ReviewCommentTarget | null;
  readonly pending: PendingReviewCommentRange | null;
}

const EMPTY_SELECTION: ReviewCommentSelection = { scope: null, target: null, pending: null };
let selection = EMPTY_SELECTION;
const listeners = new Set<() => void>();
const REVIEW_COMMENT_BLOCK_PATTERN = /<review_comment\b([^>]*)>\s*([\s\S]*?)<\/review_comment>/g;
const REVIEW_COMMENT_ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;
const REVIEW_COMMENT_FENCE_PATTERN = /(`{3,})([^\s`]*)[^\n]*\n([\s\S]*?)\n\1/g;

function setSelection(next: ReviewCommentSelection) {
  selection = next;
  listeners.forEach((listener) => listener());
}

function subscribeReviewCommentSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getReviewCommentSelection(): ReviewCommentSelection {
  return selection;
}

let lastReviewSheetId = 0;

/** A fresh id per mounted review sheet, so reopening the sheet starts without a selection. */
export function nextReviewSheetId(): number {
  lastReviewSheetId += 1;
  return lastReviewSheetId;
}

export function reviewCommentSelectionScope(
  sheetId: number,
  threadKey: string | null,
  section: { readonly id: string; readonly content: string | null } | null,
): ReviewCommentSelectionScope | null {
  return threadKey === null || section === null
    ? null
    : { key: JSON.stringify([sheetId, threadKey, section.id]), content: section.content };
}

function isSameScope(
  a: ReviewCommentSelectionScope | null,
  b: ReviewCommentSelectionScope | null,
): boolean {
  return a !== null && b !== null && a.key === b.key && a.content === b.content;
}

export function setReviewCommentTarget(
  scope: ReviewCommentSelectionScope,
  target: ReviewCommentTarget,
) {
  setSelection({ scope, target, pending: null });
}

/**
 * Keeps the pending range: when both ends are the same line the target is a single line, and
 * the range still waits for a different end.
 */
export function completeReviewCommentRange(
  scope: ReviewCommentSelectionScope,
  target: ReviewCommentTarget,
) {
  setSelection({
    scope,
    target,
    pending: isSameScope(selection.scope, scope) ? selection.pending : null,
  });
}

export function startReviewCommentRange(
  scope: ReviewCommentSelectionScope,
  pending: PendingReviewCommentRange,
) {
  setSelection({ scope, target: null, pending });
}

export function clearReviewCommentTarget() {
  setSelection(EMPTY_SELECTION);
}

/** A selection made in another sheet, thread or section, or over another diff, reads as empty. */
export function selectReviewCommentSelection(
  current: ReviewCommentSelection,
  scope: ReviewCommentSelectionScope | null,
): ReviewCommentSelection {
  return isSameScope(current.scope, scope) ? current : EMPTY_SELECTION;
}

export function useReviewCommentSelection(
  scope: ReviewCommentSelectionScope | null,
): ReviewCommentSelection {
  return selectReviewCommentSelection(
    useSyncExternalStore(
      subscribeReviewCommentSelection,
      getReviewCommentSelection,
      getReviewCommentSelection,
    ),
    scope,
  );
}

export function useReviewCommentTarget(): ReviewCommentTarget | null {
  return useSyncExternalStore(
    subscribeReviewCommentSelection,
    getReviewCommentSelection,
    getReviewCommentSelection,
  ).target;
}

export function getSelectedReviewCommentLines(
  target: ReviewCommentTarget,
): ReadonlyArray<ReviewRenderableLineRow> {
  return target.lines.slice(target.startIndex, target.endIndex + 1);
}

export function getReviewUnifiedLineNumber(line: ReviewRenderableLineRow): number | null {
  return line.newLineNumber ?? line.oldLineNumber;
}

export function getReviewChangeMarker(change: ReviewRenderableLineRow["change"]): string {
  if (change === "add") return "+";
  if (change === "delete") return "-";
  return " ";
}

export function buildReviewCommentTarget(
  target: Pick<ReviewCommentTarget, "sectionId" | "sectionTitle" | "filePath" | "lines">,
  anchorIndex: number,
  lineIndex: number,
): ReviewCommentTarget {
  return {
    sectionId: target.sectionId,
    sectionTitle: target.sectionTitle,
    filePath: target.filePath,
    lines: target.lines,
    startIndex: Math.min(anchorIndex, lineIndex),
    endIndex: Math.max(anchorIndex, lineIndex),
  };
}

export function formatReviewSelectedRangeLabel(target: ReviewCommentTarget): string {
  const lines = getSelectedReviewCommentLines(target);
  const firstLine = lines[0]!;
  const lastLine = lines[lines.length - 1]!;
  const firstNumber = getReviewUnifiedLineNumber(firstLine);
  const lastNumber = getReviewUnifiedLineNumber(lastLine);

  if (firstNumber === null || lastNumber === null) {
    return lines.length === 1 ? "line" : `${lines.length} lines`;
  }

  const firstMarker = getReviewChangeMarker(firstLine.change).trim();
  const consistentMarker =
    lines.every((line) => line.change === firstLine.change) && firstMarker.length > 0
      ? getReviewChangeMarker(firstLine.change)
      : "";

  if (firstNumber === lastNumber) {
    return `${consistentMarker}${firstNumber}`;
  }

  return `${consistentMarker}${firstNumber} to ${consistentMarker}${lastNumber}`;
}

function getDiffHunkRange(
  selectedLines: ReadonlyArray<ReviewRenderableLineRow>,
  key: "oldLineNumber" | "newLineNumber",
): {
  readonly start: number;
  readonly count: number;
} {
  const numberedLines = selectedLines.filter((line) => line[key] !== null);
  if (numberedLines.length === 0) {
    return { start: 0, count: 0 };
  }

  return {
    start: numberedLines[0]![key] ?? 0,
    count: numberedLines.length,
  };
}

function formatReviewSelectedDiff(target: ReviewCommentTarget): string {
  const selectedLines = getSelectedReviewCommentLines(target);
  const oldRange = getDiffHunkRange(selectedLines, "oldLineNumber");
  const newRange = getDiffHunkRange(selectedLines, "newLineNumber");
  const diffBody = selectedLines
    .map((line) => `${getReviewChangeMarker(line.change)}${line.content}`)
    .join("\n");

  return [
    `@@ -${oldRange.start},${oldRange.count} +${newRange.start},${newRange.count} @@`,
    diffBody.length > 0 ? diffBody : " ",
  ].join("\n");
}

function escapeReviewCommentAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeReviewCommentAttribute(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function readReviewCommentAttributes(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of rawAttributes.matchAll(REVIEW_COMMENT_ATTRIBUTE_PATTERN)) {
    attributes[match[1]!] = unescapeReviewCommentAttribute(match[2] ?? "");
  }
  return attributes;
}

function readNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

function extractReviewCommentBody(rawBody: string): {
  text: string;
  language: string;
  contents: string;
} {
  const matches = Array.from(rawBody.matchAll(REVIEW_COMMENT_FENCE_PATTERN));
  const match = matches.at(-1);
  const fenceIndex = match?.index;
  return {
    text: rawBody.slice(0, fenceIndex ?? rawBody.length).trim(),
    language: match?.[2]?.trim() || "diff",
    contents: match?.[3] ?? "",
  };
}

function parseReviewInlineComment(
  rawAttributes: string,
  rawBody: string,
  index: number,
): ReviewInlineComment | null {
  const attributes = readReviewCommentAttributes(rawAttributes);
  const startIndex = readNonNegativeInteger(attributes.startIndex);
  const endIndex = readNonNegativeInteger(attributes.endIndex);
  const filePath = attributes.filePath?.trim();
  const sectionId = attributes.sectionId?.trim();
  if (!filePath || !sectionId || startIndex === null || endIndex === null) {
    return null;
  }
  const body = extractReviewCommentBody(rawBody);

  return {
    id: `review-comment:${index}:${sectionId}:${filePath}:${startIndex}:${endIndex}`,
    sectionId,
    sectionTitle: attributes.sectionTitle?.trim() || "Review",
    filePath,
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
    rangeLabel: attributes.rangeLabel?.trim() || "line",
    text: body.text,
    diff: body.contents,
    fenceLanguage: body.language,
  };
}

export function formatReviewCommentContext(target: ReviewCommentTarget, comment: string): string {
  const rangeLabel = formatReviewSelectedRangeLabel(target);
  const diff = formatReviewSelectedDiff(target);
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(diff.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [
    [
      "<review_comment",
      ` sectionId="${escapeReviewCommentAttribute(target.sectionId)}"`,
      ` sectionTitle="${escapeReviewCommentAttribute(target.sectionTitle)}"`,
      ` filePath="${escapeReviewCommentAttribute(target.filePath)}"`,
      ` startIndex="${target.startIndex}"`,
      ` endIndex="${target.endIndex}"`,
      ` rangeLabel="${escapeReviewCommentAttribute(rangeLabel)}"`,
      ">",
    ].join(""),
    comment.trim(),
    `${fence}diff`,
    diff,
    fence,
    "</review_comment>",
  ].join("\n");
}

export function countReviewCommentContexts(value: string): number {
  return Array.from(value.matchAll(/<review_comment\b/g)).length;
}

export function parseReviewInlineComments(value: string): ReadonlyArray<ReviewInlineComment> {
  const comments: ReviewInlineComment[] = [];
  // Mask chip delimiters: labels containing </review_comment> would otherwise truncate the block.
  const masked = replaceComposerContextReferences(value, (reference) =>
    " ".repeat(reference.source.length),
  );
  for (const [index, match] of Array.from(
    masked.matchAll(REVIEW_COMMENT_BLOCK_PATTERN),
  ).entries()) {
    const matchIndex = match.index;
    const raw = value.slice(matchIndex, matchIndex + match[0].length);
    const attributeStart = "<review_comment".length;
    const attributeEnd = attributeStart + (match[1]?.length ?? 0);
    const comment = parseReviewInlineComment(
      raw.slice(attributeStart, attributeEnd),
      raw.slice(attributeEnd + 1, -"</review_comment>".length),
      index,
    );
    if (!comment) {
      continue;
    }

    comments.push(comment);
  }
  return comments;
}

export function parseReviewCommentMessageSegments(
  value: string,
): ReadonlyArray<ReviewCommentMessageSegment> {
  const segments: ReviewCommentMessageSegment[] = [];
  let cursor = 0;
  let parsedCommentIndex = 0;
  const masked = replaceComposerContextReferences(value, (reference) =>
    " ".repeat(reference.source.length),
  );
  for (const match of masked.matchAll(REVIEW_COMMENT_BLOCK_PATTERN)) {
    const matchIndex = match.index;
    const beforeText = value.slice(cursor, matchIndex);
    if (beforeText.length > 0) {
      segments.push({
        kind: "text",
        id: `review-comment-text:${cursor}`,
        text: beforeText,
      });
    }

    const raw = value.slice(matchIndex, matchIndex + match[0].length);
    const attributeStart = "<review_comment".length;
    const attributeEnd = attributeStart + (match[1]?.length ?? 0);
    const comment = parseReviewInlineComment(
      raw.slice(attributeStart, attributeEnd),
      raw.slice(attributeEnd + 1, -"</review_comment>".length),
      parsedCommentIndex,
    );
    if (comment) {
      segments.push({ kind: "review-comment", comment });
      parsedCommentIndex += 1;
    } else {
      segments.push({
        kind: "text",
        id: `review-comment-invalid:${matchIndex}`,
        text: value.slice(matchIndex, matchIndex + match[0].length),
      });
    }

    cursor = matchIndex + match[0].length;
  }

  const rest = value.slice(cursor);
  if (rest.length > 0) {
    segments.push({
      kind: "text",
      id: `review-comment-text:${cursor}`,
      text: rest,
    });
  }

  return segments;
}
