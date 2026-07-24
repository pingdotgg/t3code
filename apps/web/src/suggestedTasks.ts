import type { GitResolvedIssue, GitResolvedPullRequest } from "@t3tools/contracts";

export const REVIEW_CURRENT_CHANGES_PROMPT =
  "Review the current changes in this workspace. Inspect the diff, identify correctness, security, performance, and maintainability risks, and recommend focused improvements. Do not make changes until you have summarized what you found.";

export const FIX_FAILING_CHECKS_PROMPT =
  "Find the smallest relevant test, lint, formatting, and type-check commands for this project. Run the focused checks, diagnose any failures, implement fixes, and rerun the affected checks to verify them.";

export function buildPullRequestTask(input: GitResolvedPullRequest): {
  readonly title: string;
  readonly prompt: string;
} {
  return {
    title: `PR #${input.number} · ${input.title}`,
    prompt: `Review PR #${input.number}, “${input.title}” (${input.url}). Understand the changes, run the relevant checks, identify correctness or maintainability issues, and suggest fixes. Do not make changes until you have summarized what you found.`,
  };
}

export function buildIssueTriageTask(input: GitResolvedIssue): {
  readonly title: string;
  readonly prompt: string;
} {
  return {
    title: `Triage #${input.number} · ${input.title}`,
    prompt: `Triage issue #${input.number}, “${input.title}” (${input.url}). Read the issue and inspect the relevant code. Determine the likely cause, reproduction steps, scope, severity, and a concrete next action. Do not implement changes yet.`,
  };
}
