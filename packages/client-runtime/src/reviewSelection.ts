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

/** Retains both ends of the selected comment range. */
export function reviewPositionRange(
  start: PullRequestReviewPosition,
  end: PullRequestReviewPosition,
): PullRequestReviewPosition {
  const from = reviewPositionAnchor(start);
  const to = reviewPositionAnchor(end);
  if (from.line === to.line && from.side === to.side) return end;
  if (from.side === to.side && from.line > to.line) return reviewPositionRange(end, start);
  return { ...end, startLine: from.line, startSide: from.side };
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

export function reviewPositionLabel(position: PullRequestReviewPosition) {
  return reviewLineRangeLabel({
    ...reviewPositionAnchor(position),
    startLine: position.startLine,
    startSide: position.startSide,
  });
}
