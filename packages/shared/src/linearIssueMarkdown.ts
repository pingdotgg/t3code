import type { LinearIssueContextRecord } from "@t3tools/contracts";

export type LinearIssueSnapshot = Omit<
  LinearIssueContextRecord,
  "version" | "kind" | "contextId" | "label"
>;

const SUB_ISSUE_CHECKBOX: Readonly<Record<string, string>> = {
  completed: "[x]",
  canceled: "[-]",
};

/** One text rendering of an issue, shared by the agent's context payload and pipeline input. */
export function formatLinearIssueMarkdown(snapshot: LinearIssueSnapshot): string {
  const meta = [
    snapshot.teamName,
    snapshot.projectName,
    snapshot.milestoneName,
    snapshot.priorityLabel,
    snapshot.stateName,
  ].filter((part): part is string => part !== null && part.length > 0);
  // Bullets, not bare lines: a single newline renders as a space in the dialog's preview.
  const lines = [`# ${snapshot.identifier} · ${snapshot.title}`, "", meta.join(" · "), ""];
  lines.push(`- Linear: ${snapshot.url}`);
  if (snapshot.branchName) lines.push(`- Branch: ${snapshot.branchName}`);
  if (snapshot.assigneeName) lines.push(`- Assignee: ${snapshot.assigneeName}`);
  if (snapshot.labels.length > 0) lines.push(`- Labels: ${snapshot.labels.join(", ")}`);
  if (snapshot.description.trim()) lines.push("", snapshot.description.trim());
  if (snapshot.subIssues.length > 0) {
    lines.push("", "## Sub-issues", "");
    for (const sub of snapshot.subIssues) {
      lines.push(`- ${SUB_ISSUE_CHECKBOX[sub.stateType] ?? "[ ]"} ${sub.identifier} ${sub.title}`);
    }
  }
  if (snapshot.comments.length > 0) {
    lines.push("", "## Comments");
    for (const comment of snapshot.comments) {
      lines.push(
        "",
        `**${comment.author ?? "Unknown"}** · ${comment.createdAt}`,
        "",
        comment.body.trim(),
      );
    }
  }
  if (snapshot.linkedPullRequests.length > 0) {
    lines.push("", "## Linked pull requests", "");
    for (const pr of snapshot.linkedPullRequests) lines.push(`- ${pr}`);
  }
  return lines.join("\n");
}
