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

/** A picker's picks, the read of the issue they were made against, and the set they last wrote. */
export interface IssuePicks<T> {
  readonly basis: object | null;
  readonly draft: SelectionDraft<T>;
  readonly written: ReadonlyArray<string> | null;
}

export function noIssuePicks<T>(): IssuePicks<T> {
  return { basis: null, draft: new Map(), written: null };
}

/**
 * The picks that count against `detail`. A write replaces the whole set and the detail only
 * catches up once it is re-read, so picks outlive their write until then: a picker reopened in
 * between builds on them instead of on the stale set. A newer read forgets them, except in an
 * open picker, whose picks are diffed against that read when it closes.
 */
export function issuePicksFor<T>(
  picks: IssuePicks<T>,
  detail: object,
  open: boolean,
): IssuePicks<T> {
  if (picks.basis === detail) return picks;
  return { basis: detail, draft: open ? picks.draft : new Map(), written: null };
}

/**
 * A write that failed is forgotten along with the picks it carried, unless the picker was picked
 * in again since: those picks stay, and the next close writes them with the ones that failed.
 */
export function issuePicksAfterFailedWrite<T>(
  latest: IssuePicks<T>,
  sent: IssuePicks<T>,
): IssuePicks<T> {
  if (latest.written !== sent.written) return latest;
  return latest.draft === sent.draft ? noIssuePicks() : { ...latest, written: null };
}

/** The set a closing picker writes: null when the tracker has it or was already sent it. */
export function issueWriteAfterPicks(
  after: ReadonlyArray<string> | null,
  held: ReadonlyArray<string>,
  written: ReadonlyArray<string> | null,
): ReadonlyArray<string> | null {
  const target = after ?? held;
  const sent = written ?? held;
  const same = target.length === sent.length && target.every((value) => sent.includes(value));
  return same ? null : target;
}
