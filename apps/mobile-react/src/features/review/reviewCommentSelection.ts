import { useSyncExternalStore } from "react";

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

let currentTarget: ReviewCommentTarget | null = null;
const listeners = new Set<() => void>();
const REVIEW_COMMENT_BLOCK_PATTERN = /<review_comment\b([^>]*)>\s*([\s\S]*?)<\/review_comment>/g;
const REVIEW_COMMENT_ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;

function emitChange() {
  listeners.forEach((listener) => listener());
}

export function subscribeReviewCommentTarget(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getReviewCommentTarget(): ReviewCommentTarget | null {
  return currentTarget;
}

export function setReviewCommentTarget(target: ReviewCommentTarget | null) {
  currentTarget = target;
  emitChange();
}

export function clearReviewCommentTarget() {
  currentTarget = null;
  emitChange();
}

export function useReviewCommentTarget(): ReviewCommentTarget | null {
  return useSyncExternalStore(
    subscribeReviewCommentTarget,
    getReviewCommentTarget,
    getReviewCommentTarget,
  );
}

export function getSelectedReviewCommentLines(
  target: ReviewCommentTarget,
): ReadonlyArray<ReviewRenderableLineRow> {
  return target.lines.slice(target.startIndex, target.endIndex + 1);
}

export function getReviewUnifiedLineNumber(line: ReviewRenderableLineRow): number | null {
  return line.newLineNumber ?? line.oldLineNumber;
}

export function formatReviewLineLabel(line: ReviewRenderableLineRow): string {
  if (line.newLineNumber !== null) {
    return `new line ${line.newLineNumber}`;
  }
  if (line.oldLineNumber !== null) {
    return `old line ${line.oldLineNumber}`;
  }
  return "file";
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
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function unescapeReviewCommentAttribute(value: string): string {
  return value
    .replace(/&lt;/g, "<")
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

function extractReviewCommentText(rawBody: string): string {
  const fenceIndex = rawBody.indexOf("```diff");
  const commentBody = fenceIndex >= 0 ? rawBody.slice(0, fenceIndex) : rawBody;
  return commentBody.trim();
}

function extractReviewCommentDiff(rawBody: string): string {
  const match = rawBody.match(/```diff\s*\n([\s\S]*?)\n```/);
  return match?.[1]?.trim() ?? "";
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

  return {
    id: `review-comment:${index}:${sectionId}:${filePath}:${startIndex}:${endIndex}`,
    sectionId,
    sectionTitle: attributes.sectionTitle?.trim() || "Review",
    filePath,
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
    rangeLabel: attributes.rangeLabel?.trim() || "line",
    text: extractReviewCommentText(rawBody),
    diff: extractReviewCommentDiff(rawBody),
  };
}

export function formatReviewCommentContext(target: ReviewCommentTarget, comment: string): string {
  const rangeLabel = formatReviewSelectedRangeLabel(target);
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
    "```diff",
    formatReviewSelectedDiff(target),
    "```",
    "</review_comment>",
  ].join("\n");
}

export function countReviewCommentContexts(value: string): number {
  return Array.from(value.matchAll(/<review_comment\b/g)).length;
}

export function parseReviewInlineComments(value: string): ReadonlyArray<ReviewInlineComment> {
  const comments: ReviewInlineComment[] = [];
  for (const [index, match] of Array.from(value.matchAll(REVIEW_COMMENT_BLOCK_PATTERN)).entries()) {
    const comment = parseReviewInlineComment(match[1] ?? "", match[2] ?? "", index);
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

  for (const match of value.matchAll(REVIEW_COMMENT_BLOCK_PATTERN)) {
    const matchIndex = match.index ?? 0;
    const beforeText = value.slice(cursor, matchIndex);
    if (beforeText.length > 0) {
      segments.push({
        kind: "text",
        id: `review-comment-text:${cursor}`,
        text: beforeText,
      });
    }

    const comment = parseReviewInlineComment(match[1] ?? "", match[2] ?? "", parsedCommentIndex);
    if (comment) {
      segments.push({ kind: "review-comment", comment });
      parsedCommentIndex += 1;
    } else {
      segments.push({
        kind: "text",
        id: `review-comment-invalid:${matchIndex}`,
        text: match[0],
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
