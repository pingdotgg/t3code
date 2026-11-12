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

export function reviewLineRangeLabel(input: {
  line: number | null;
  side: "left" | "right";
  startLine?: number | undefined;
  startSide?: "left" | "right" | undefined;
}) {
  if (input.line === null) return "File";
  const prefix = input.side === "left" ? "Old line" : "Line";
  if (input.startLine === undefined) return `${prefix} ${input.line}`;
  const fromSide = input.startSide ?? input.side;
  return fromSide === input.side
    ? `${prefix}s ${input.startLine}–${input.line}`
    : `${fromSide === "left" ? "Old line" : "Line"} ${input.startLine} → ${input.side === "left" ? "old line" : "line"} ${input.line}`;
}

export function reviewPositionLabel(
  position: PullRequestReviewPosition,
  startPosition?: PullRequestReviewPosition,
) {
  const start =
    startPosition === undefined || sameAnchor(startPosition, position)
      ? undefined
      : reviewPositionAnchor(startPosition);
  return reviewLineRangeLabel({
    ...reviewPositionAnchor(position),
    startLine: start?.line,
    startSide: start?.side,
  });
}
