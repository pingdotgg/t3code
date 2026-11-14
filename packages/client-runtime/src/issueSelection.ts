import type { IssueAssigneeCandidate, IssueDetail, IssueLabelCandidate } from "@t3tools/contracts";

import { selectionChanges, type SelectionDraft } from "./pullRequestSelection.ts";

type Labelled = Pick<IssueDetail, "labels">;
type Assigned = Pick<IssueDetail, "assignees">;

/**
 * An issue write replaces the whole set, so a picker's picks become one write when it closes.
 * Both return null when the picks leave the issue as the tracker already has it.
 */
export function issueLabelsAfterPicks(
  detail: Labelled,
  draft: SelectionDraft<IssueLabelCandidate>,
): ReadonlyArray<string> | null {
  const names = detail.labels.map((label) => label.name);
  const { add, remove } = selectionChanges(draft, (name) => names.includes(name));
  if (add.length + remove.length === 0) return null;
  const removed = new Set(remove.map((label) => label.name));
  return [...names.filter((name) => !removed.has(name)), ...add.map((label) => label.name)];
}

export const issueAssigneeHeld = (detail: Assigned, candidate: IssueAssigneeCandidate) =>
  detail.assignees.some((actor) => actor.login.toLowerCase() === candidate.login.toLowerCase());

/** People already assigned are written by login, the newly picked by the tracker's own id. */
export function issueAssigneesAfterPicks(
  detail: Assigned,
  draft: SelectionDraft<IssueAssigneeCandidate>,
): ReadonlyArray<string> | null {
  const { add, remove } = selectionChanges(draft, (_, candidate) =>
    issueAssigneeHeld(detail, candidate),
  );
  if (add.length + remove.length === 0) return null;
  const removed = new Set(remove.map((candidate) => candidate.login.toLowerCase()));
  return [
    ...detail.assignees
      .map((actor) => actor.login)
      .filter((login) => !removed.has(login.toLowerCase())),
    ...add.map((candidate) => candidate.id),
  ];
}
