import type { PullRequestAssigneeCandidate } from "@t3tools/contracts";

/**
 * The assignee menu's rows: the people the menu first loaded, narrowed to what was typed, then
 * whoever the host's own search found beyond them. Anybody in both comes from the first list,
 * since that is the one an assignment updates.
 */
export function mergeAssigneeCandidates(
  loaded: ReadonlyArray<PullRequestAssigneeCandidate>,
  searched: ReadonlyArray<PullRequestAssigneeCandidate>,
  query: string,
): ReadonlyArray<PullRequestAssigneeCandidate> {
  const needle = query.trim().toLowerCase();
  const known = new Set(loaded.map((candidate) => candidate.id));
  return [
    ...loaded.filter(
      (candidate) =>
        needle.length === 0 ||
        candidate.login.toLowerCase().includes(needle) ||
        (candidate.name ?? "").toLowerCase().includes(needle),
    ),
    // The host matched these on its own terms, an email for one, so they are not narrowed again.
    ...searched.filter((candidate) => !known.has(candidate.id)),
  ];
}
