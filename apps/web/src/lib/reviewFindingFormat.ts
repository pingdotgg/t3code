import type { ReviewFinding } from "@t3tools/contracts";

const PRIORITY_LABELS = {
  critical: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
} as const;

export function reviewFindingLocationLabel(finding: ReviewFinding): string {
  return `${finding.location.path}:${finding.location.startLine}`;
}

export function formatReviewFinding(finding: ReviewFinding): string {
  const label = PRIORITY_LABELS[finding.priority];
  return `[${label}] ${finding.title}\n${reviewFindingLocationLabel(finding)}\n\n${finding.body}`;
}

export function formatReviewFindings(findings: readonly ReviewFinding[]): string {
  return findings
    .map((finding, index) => `${index + 1}. ${formatReviewFinding(finding)}`)
    .join("\n\n");
}
