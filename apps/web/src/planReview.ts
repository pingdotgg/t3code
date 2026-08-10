import { proposedPlanTitle } from "./proposedPlan";

export function buildPlanReviewThreadTitle(planMarkdown: string): string {
  return `Review plan · ${proposedPlanTitle(planMarkdown) ?? "Untitled plan"}`;
}

export function buildPlanReviewPrompt(input: {
  readonly planMarkdown: string;
  readonly instructions: string;
}): string {
  const instructions = input.instructions.trim();
  return [
    "Review this proposed implementation plan. Do not implement it or make any file changes.",
    "",
    "## Proposed plan",
    "",
    input.planMarkdown.trim(),
    ...(instructions.length > 0 ? ["", "## Review instructions", "", instructions] : []),
  ].join("\n");
}

export function buildPlanRevisionPrompt(input: {
  readonly planMarkdown: string;
  readonly reviewFeedback: string;
}): string {
  return [
    "A separate agent reviewed the plan below.",
    "",
    "## Original plan",
    "",
    input.planMarkdown.trim(),
    "",
    "## Reviewer feedback",
    "",
    input.reviewFeedback.trim(),
    "",
    "Revise the plan to address valid feedback. Do not implement anything. Return a complete replacement proposed plan, preserving valid parts of the original and making assumptions explicit.",
  ].join("\n");
}
