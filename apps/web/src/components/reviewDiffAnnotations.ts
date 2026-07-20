import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type { ReviewFinding } from "@t3tools/contracts";

function diffSide(side: ReviewFinding["location"]["side"]): "additions" | "deletions" {
  return side === "new" ? "additions" : "deletions";
}

export function reviewFindingAnnotation(finding: ReviewFinding): DiffLineAnnotation<ReviewFinding> {
  return {
    side: diffSide(finding.location.side),
    lineNumber: finding.location.endLine,
    metadata: finding,
  };
}

export function reviewFindingSelectedLines(finding: ReviewFinding): SelectedLineRange {
  const side = diffSide(finding.location.side);
  return {
    start: finding.location.startLine,
    end: finding.location.endLine,
    side,
    endSide: side,
  };
}
