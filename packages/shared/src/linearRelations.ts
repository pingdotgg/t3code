import type { LinearIssue, LinearIssueRef } from "@t3tools/contracts";

type Blockable = Pick<LinearIssue, "blockedBy" | "state">;

/** Done work no longer blocks anything. */
function isOpenType(type: LinearIssueRef["state"]["type"]): boolean {
  return type !== "completed" && type !== "canceled";
}

function isOpen(ref: LinearIssueRef): boolean {
  return isOpenType(ref.state.type);
}

/** Direct blockers only; a blocked parent does not block its sub-issues. */
export function openBlockers(issue: Pick<LinearIssue, "blockedBy">): ReadonlyArray<LinearIssueRef> {
  return issue.blockedBy.filter(isOpen);
}

/** Finished or canceled issues are never shown as blocked, whatever relations they still carry. */
export function isLinearIssueBlocked(issue: Blockable): boolean {
  return isOpenType(issue.state.type) && openBlockers(issue).length > 0;
}

/** Open blockers first so the ones that matter lead; order is otherwise preserved. */
export function sortBlockers(blockers: ReadonlyArray<LinearIssueRef>): Array<LinearIssueRef> {
  return [...blockers.filter(isOpen), ...blockers.filter((ref) => !isOpen(ref))];
}

export function isLinearRefOpen(ref: LinearIssueRef): boolean {
  return isOpen(ref);
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
