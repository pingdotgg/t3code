import type { GitRunStackedActionResult } from "@t3tools/contracts";

/** What the user tells the orchestrator after a commit in one of its ticket worktrees. */
export function commitSummary(worktree: string, result: GitRunStackedActionResult): string {
  const { commit, push, pr } = result;
  const parts = [
    commit.status === "created" && commit.commitSha !== undefined
      ? `committed ${commit.commitSha.slice(0, 7)}${commit.subject === undefined ? "" : ` "${commit.subject}"`}`
      : "found nothing new to commit",
  ];
  if (push.status === "pushed")
    parts.push(`pushed ${push.upstreamBranch ?? push.branch ?? "the branch"}`);
  if (pr.status !== "skipped_not_requested" && pr.number !== undefined) {
    parts.push(
      `${pr.status === "created" ? "opened" : "found"} PR #${pr.number}${pr.url === undefined ? "" : ` (${pr.url})`}`,
    );
  }
  return `I ${parts.join(", ")} in ${worktree}.`;
}
