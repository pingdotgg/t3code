import type { LinearIssue, LinearIssueDetail, LinearIssueRef } from "@t3tools/contracts";

/** Done work no longer blocks anything. */
function isOpenType(type: LinearIssueRef["state"]["type"]): boolean {
  return type !== "completed" && type !== "canceled";
}

export function isLinearRefOpen(ref: LinearIssueRef): boolean {
  return isOpenType(ref.state.type);
}

/** Direct blockers only; a blocked parent does not block its sub-issues. */
export function openBlockers(issue: Pick<LinearIssue, "blockedBy">): ReadonlyArray<LinearIssueRef> {
  return issue.blockedBy.filter(isLinearRefOpen);
}

/** Finished or canceled issues are never shown as blocked, whatever relations they still carry. */
export function isLinearIssueBlocked(issue: Pick<LinearIssue, "blockedBy" | "state">): boolean {
  return isOpenType(issue.state.type) && openBlockers(issue).length > 0;
}

/** Open blockers first so the ones that matter lead; order is otherwise preserved. */
export function sortBlockers(blockers: ReadonlyArray<LinearIssueRef>): Array<LinearIssueRef> {
  return [...blockers.filter(isLinearRefOpen), ...blockers.filter((ref) => !isLinearRefOpen(ref))];
}

/** "Blocked by ATT-12, ATT-15" for tooltips. */
export function blockedByTitle(issue: Pick<LinearIssue, "blockedBy">): string {
  return `Blocked by ${openBlockers(issue)
    .map((ref) => ref.identifier)
    .join(", ")}`;
}

/** Header line: the identifier for one blocker, a count for more. */
export function blockedBySummary(issue: Pick<LinearIssue, "blockedBy">): string {
  const open = openBlockers(issue);
  return open.length === 1 && open[0]
    ? `Blocked by ${open[0].identifier}`
    : `Blocked by ${open.length} issues`;
}

export interface LinearRelationGroup {
  readonly title: string;
  readonly refs: ReadonlyArray<LinearIssueRef>;
}

/** The detail's Relations section, in display order; empty groups are left out. */
export function linearRelationGroups(
  detail: Pick<LinearIssueDetail, "blocks" | "relatedIssues" | "duplicates"> & {
    readonly issue: Pick<LinearIssue, "blockedBy">;
  },
): ReadonlyArray<LinearRelationGroup> {
  const groups: ReadonlyArray<LinearRelationGroup> = [
    { title: "Blocked by", refs: sortBlockers(detail.issue.blockedBy) },
    { title: "Blocking", refs: detail.blocks },
    { title: "Related", refs: detail.relatedIssues },
    {
      title: "Duplicate of",
      refs: detail.duplicates.filter((ref) => ref.direction === "duplicateOf"),
    },
    {
      title: "Duplicated by",
      refs: detail.duplicates.filter((ref) => ref.direction === "duplicatedBy"),
    },
  ];
  return groups.filter((group) => group.refs.length > 0);
}
