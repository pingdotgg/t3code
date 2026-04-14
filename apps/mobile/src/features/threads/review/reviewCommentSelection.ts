import { useSyncExternalStore } from "react";

import type { ReviewRenderableLineRow } from "./reviewModel";

export interface ReviewCommentTarget {
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly startIndex: number;
  readonly endIndex: number;
}

let currentTarget: ReviewCommentTarget | null = null;
const listeners = new Set<() => void>();

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
  target: Pick<ReviewCommentTarget, "sectionTitle" | "filePath" | "lines">,
  anchorIndex: number,
  lineIndex: number,
): ReviewCommentTarget {
  return {
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

export function formatReviewCommentContext(target: ReviewCommentTarget, comment: string): string {
  return [
    "<review_comment>",
    comment.trim(),
    "```diff",
    formatReviewSelectedDiff(target),
    "```",
    "</review_comment>",
  ].join("\n");
}
