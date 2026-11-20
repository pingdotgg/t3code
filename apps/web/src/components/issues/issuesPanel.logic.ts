import { msg } from "gt-react";
import { m } from "../../i18n/messages";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import type { IssueListEntry, IssueListState } from "@t3tools/contracts";

export const ISSUE_STATE_FILTERS: ReadonlyArray<{
  readonly value: IssueListState;
  readonly label: string;
}> = [
  { value: "open", label: m(msg("Open")) },
  { value: "closed", label: m(msg("Closed")) },
  { value: "all", label: m(msg("All")) },
];

export const ISSUE_SORTS = [
  { value: "recent", label: m(msg("Recent")) },
  { value: "oldest", label: m(msg("Oldest")) },
  { value: "comments", label: m(msg("Discussed")) },
] as const;

export type IssueSort = (typeof ISSUE_SORTS)[number]["value"];

export function sortIssues(
  entries: ReadonlyArray<IssueListEntry>,
  sort: IssueSort = "recent",
): ReadonlyArray<IssueListEntry> {
  const rows = [...entries];
  switch (sort) {
    case "oldest":
      return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    case "comments":
      // A host that reports no counts leaves every row at zero, so this falls back to recency
      // rather than shuffling the list into an order that means nothing.
      return rows.sort(
        (left, right) =>
          right.commentCount - left.commentCount || right.updatedAt.localeCompare(left.updatedAt),
      );
    case "recent":
      return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

/**
 * What a search box narrows locally.
 *
 * Only used for a host that does not search its own issues: where one does, it has already
 * matched bodies this cannot see, and narrowing again would hide rows it deliberately returned.
 */
export function narrowIssues(
  entries: ReadonlyArray<IssueListEntry>,
  query: string,
): ReadonlyArray<IssueListEntry> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return entries;
  return entries.filter(
    (entry) =>
      entry.title.toLowerCase().includes(needle) ||
      entry.key.toLowerCase() === needle.replace(/^#/u, "") ||
      entry.labels.some((label) => label.name.toLowerCase().includes(needle)),
  );
}

/** "3 comments", or nothing at all where the host does not count them. */
export function formatCommentCount(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}

/** A label colour as CSS, guarding against whatever a host chose to put in that field. */
export function labelColor(color: string | null): string | undefined {
  if (color === null) return undefined;
  const hex = color.trim().replace(/^#/u, "");
  return /^[0-9a-f]{3}$|^[0-9a-f]{6}$/iu.test(hex) ? `#${hex}` : undefined;
}

export function issueContextForComposer(issue: {
  readonly displayKey: string;
  readonly title: string;
  readonly url: string;
  readonly state: { readonly name: string };
  readonly scope: string;
  readonly body: string;
  readonly comments: ReadonlyArray<{
    readonly author: { readonly login: string } | null;
    readonly body: string;
  }>;
}): string {
  const lines = [
    `## ${issue.scope}${issue.displayKey.startsWith("#") ? "" : "/"}${issue.displayKey}: ${issue.title}`,
    "",
    `State: ${issue.state.name}`,
    `Link: ${issue.url}`,
    "",
    issue.body.trim().length > 0 ? issue.body.trim() : "_No description._",
  ];
  for (const comment of issue.comments) {
    lines.push(
      "",
      `### Comment from ${comment.author?.login ?? "unknown"}`,
      "",
      comment.body.trim(),
    );
  }
  return lines.join("\n");
}

/**
 * The composer's new contents once an issue is added.
 *
 * Appended rather than replacing: whatever was already typed is the reader's, and an issue is
 * context for it rather than a substitute.
 */
export function appendIssueContext(prompt: string, context: string): string {
  const existing = prompt.trimEnd();
  return existing.length === 0 ? `${context}\n\n` : `${existing}\n\n${context}\n\n`;
}

export function issueBranchName(issue: { readonly key: string; readonly title: string }): string {
  const key = sanitizeBranchFragment(issue.key);
  const slug = sanitizeBranchFragment(issue.title);
  return slug.length === 0 || slug === "update" ? `issue-${key}` : `issue-${key}-${slug}`;
}

const ISSUE_BRANCH_PATTERN = /^issue-(\d+)(?:-|$)/u;

export function issueNumberFromBranch(branch: string | null | undefined): number | null {
  if (typeof branch !== "string") return null;
  // A worktree branch may carry a namespace, so the last segment is the one that was named here.
  const segment = branch.trim().split("/").at(-1) ?? "";
  const matched = Number(ISSUE_BRANCH_PATTERN.exec(segment)?.[1]);
  return Number.isSafeInteger(matched) && matched > 0 ? matched : null;
}
