import type { PullRequestReviewerCandidate } from "@t3tools/contracts";

/**
 * The reviewer menu's rows: the candidates the menu first loaded, narrowed to what was typed, then
 * whoever the host's own search found beyond them. Anybody in both comes from the first list,
 * since that is the one a review request updates.
 */
export function mergeReviewerCandidates(
  loaded: ReadonlyArray<PullRequestReviewerCandidate>,
  searched: ReadonlyArray<PullRequestReviewerCandidate>,
  query: string,
): ReadonlyArray<PullRequestReviewerCandidate> {
  const needle = query.trim().toLowerCase();
  const key = (candidate: PullRequestReviewerCandidate) => `${candidate.kind}:${candidate.id}`;
  const known = new Set(loaded.map(key));
  return [
    ...loaded.filter(
      (candidate) =>
        needle.length === 0 ||
        candidate.login.toLowerCase().includes(needle) ||
        (candidate.name ?? "").toLowerCase().includes(needle),
    ),
    // The host matched these on its own terms, an email for one, so they are not narrowed again.
    ...searched.filter((candidate) => !known.has(key(candidate))),
  ];
}
