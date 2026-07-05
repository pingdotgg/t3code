import type { LinearIssueDetail } from "@t3tools/contracts";

/**
 * How multiple imported Linear issues are laid out in the composer prompt.
 * - `combine`: merge every issue into one comprehensive task.
 * - `subtasks`: present each issue as an independent, ordered subtask.
 */
export type LinearImportMode = "combine" | "subtasks";

function metadataLine(issue: LinearIssueDetail): string | null {
  const parts: Array<string> = [];
  if (issue.stateName) parts.push(`Status: ${issue.stateName}`);
  if (issue.priorityLabel) parts.push(`Priority: ${issue.priorityLabel}`);
  if (issue.assigneeName) parts.push(`Assignee: ${issue.assigneeName}`);
  if (issue.teamKey) parts.push(`Team: ${issue.teamKey}`);
  if (issue.labels.length > 0) parts.push(`Labels: ${issue.labels.join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function sectionList(title: string, lines: ReadonlyArray<string>): ReadonlyArray<string> {
  if (lines.length === 0) return [];
  return [`**${title}**`, ...lines.map((line) => `- ${line}`), ""];
}

/** Render a single issue as a self-contained markdown block under `heading`. */
function formatIssueBlock(issue: LinearIssueDetail, heading: string): string {
  const lines: Array<string> = [heading, ""];

  const meta = metadataLine(issue);
  if (meta) {
    lines.push(meta, "");
  }
  if (issue.url) {
    lines.push(`Linear: ${issue.url}`, "");
  }

  const description = issue.description.trim();
  if (description.length > 0) {
    // The description carries any acceptance criteria / checklists inline as
    // markdown; preserve it verbatim so checkboxes survive the import.
    lines.push("**Description**", "", description, "");
  }

  lines.push(
    ...sectionList(
      "Sub-issues",
      issue.subIssues.map((sub) =>
        sub.stateName
          ? `${sub.identifier}: ${sub.title} (${sub.stateName})`
          : `${sub.identifier}: ${sub.title}`,
      ),
    ),
  );

  lines.push(
    ...sectionList(
      "Linked pull requests",
      issue.linkedPullRequests.map((pr) => (pr.title ? `[${pr.title}](${pr.url})` : pr.url)),
    ),
  );

  lines.push(
    ...sectionList(
      "Attachments",
      issue.attachments.map((attachment) =>
        attachment.title ? `[${attachment.title}](${attachment.url})` : attachment.url,
      ),
    ),
  );

  if (issue.comments.length > 0) {
    lines.push("**Comments**", "");
    for (const comment of issue.comments) {
      const author = comment.author ?? "Unknown";
      const when = comment.createdAt ? ` (${comment.createdAt})` : "";
      lines.push(`> **${author}**${when}:`);
      for (const bodyLine of comment.body.trim().split("\n")) {
        lines.push(`> ${bodyLine}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

/**
 * Build the composer prompt for one or more imported Linear issues.
 * Pure and deterministic — safe to unit test.
 */
export function formatLinearIssues(
  issues: ReadonlyArray<LinearIssueDetail>,
  mode: LinearImportMode,
): string {
  if (issues.length === 0) return "";

  if (issues.length === 1) {
    const issue = issues[0]!;
    return `Work on this Linear issue:\n\n${formatIssueBlock(
      issue,
      `## ${issue.identifier}: ${issue.title}`,
    )}\n`;
  }

  if (mode === "subtasks") {
    const blocks = issues.map((issue, index) =>
      formatIssueBlock(issue, `## Subtask ${index + 1} — ${issue.identifier}: ${issue.title}`),
    );
    return `These related Linear issues should be implemented as subtasks:\n\n${blocks.join(
      "\n\n",
    )}\n`;
  }

  const blocks = issues.map((issue) =>
    formatIssueBlock(issue, `## ${issue.identifier}: ${issue.title}`),
  );
  return `Work on these Linear issues together as one task:\n\n${blocks.join("\n\n")}\n`;
}
