import type { GitFetchPrDetailsResult } from "@t3tools/contracts";

/**
 * Normalize a PR reference by stripping URL fragments and query params.
 * e.g. "https://github.com/org/repo/pull/72#pullrequestreview-123" -> "https://github.com/org/repo/pull/72"
 */
export function normalizePrReference(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("http")) return trimmed;
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function buildReviewPrompt(pr: GitFetchPrDetailsResult): string {
  const lines = [
    `Review PR #${pr.number}: ${pr.title}`,
    "",
    `Base: \`${pr.baseRefName}\` <- Head: \`${pr.headRefName}\``,
    `Changes: +${pr.additions} -${pr.deletions} across ${pr.changedFiles} file${pr.changedFiles !== 1 ? "s" : ""}`,
    "",
  ];

  if (pr.body.trim().length > 0) {
    lines.push("## PR Description", "", pr.body.trim(), "");
  }

  lines.push(
    "---",
    "",
    "## Review Instructions",
    "",
    "Review the changes in this PR. Focus on correctness, performance, and potential issues.",
    "",
    "**Important:** If a code-review skill is available, use it to guide your review process.",
    "",
    "Use the `review_comment` tool to annotate specific lines with your findings. Each comment should target a file and line number from the diff.",
    "",
    "Severity levels: info, suggestion, issue, blocker.",
    "",
    "After reviewing all files, provide a brief overall summary of your findings.",
  );

  return lines.join("\n");
}
