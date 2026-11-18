import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { PullRequestReviewPosition } from "@t3tools/contracts";

export function reviewPositionAnchor(position: PullRequestReviewPosition) {
  switch (position.kind) {
    case "added":
      return { line: position.newLine, side: "right" as const };
    case "deleted":
      return { line: position.oldLine, side: "left" as const };
    case "context":
      return {
        line: position.side === "left" ? position.oldLine : position.newLine,
        side: position.side,
      };
  }
}

function sameAnchor(left: PullRequestReviewPosition, right: PullRequestReviewPosition) {
  const from = reviewPositionAnchor(left);
  const to = reviewPositionAnchor(right);
  return from.line === to.line && from.side === to.side;
}

/**
 * Orders both ends of a selected comment range: hosts anchor a comment at its last line and
 * refuse a start after it. A one-line selection has no start.
 */
export function reviewCommentRange(
  start: PullRequestReviewPosition,
  end: PullRequestReviewPosition,
): {
  readonly position: PullRequestReviewPosition;
  readonly startPosition?: PullRequestReviewPosition;
} {
  if (sameAnchor(start, end)) return { position: end };
  const from = reviewPositionAnchor(start);
  const to = reviewPositionAnchor(end);
  if (from.side === to.side && from.line > to.line) return reviewCommentRange(end, start);
  return { position: end, startPosition: start };
}

export function reviewLineRangeLabel(
  input: {
    line: number | null;
    side: "left" | "right";
    startLine?: number | undefined;
    startSide?: "left" | "right" | undefined;
  },
  resolve: MFunctionType = mFallback,
) {
  if (input.line === null)
    return resolve(msg("File", { $context: "review comment on a whole file" }));
  const line = input.line;
  if (input.startLine === undefined)
    return input.side === "left"
      ? resolve(msg("Old line {line}", { line }))
      : resolve(msg("Line {line}", { line }));
  const start = input.startLine;
  const startSide = input.startSide ?? input.side;
  if (startSide === input.side)
    return input.side === "left"
      ? resolve(msg("Old lines {start}–{line}", { start, line }))
      : resolve(msg("Lines {start}–{line}", { start, line }));
  return startSide === "left"
    ? resolve(msg("Old line {start} → line {line}", { start, line }))
    : resolve(msg("Line {start} → old line {line}", { start, line }));
}

export function reviewPositionLabel(
  position: PullRequestReviewPosition,
  startPosition?: PullRequestReviewPosition,
  resolve: MFunctionType = mFallback,
) {
  const start =
    startPosition === undefined || sameAnchor(startPosition, position)
      ? undefined
      : reviewPositionAnchor(startPosition);
  return reviewLineRangeLabel(
    {
      ...reviewPositionAnchor(position),
      startLine: start?.line,
      startSide: start?.side,
    },
    resolve,
  );
}
