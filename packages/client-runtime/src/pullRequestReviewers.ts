import type { PullRequestReviewerCandidate } from "@t3tools/contracts";

// Loaded rows retain the request state updated by mutations.
export function mergeReviewerCandidates(
  loaded: ReadonlyArray<PullRequestReviewerCandidate>,
  searched: ReadonlyArray<PullRequestReviewerCandidate>,
  query: string,
): ReadonlyArray<PullRequestReviewerCandidate> {
  const needle = query.trim().toLowerCase();
  const key = (candidate: PullRequestReviewerCandidate) => `${candidate.kind}:${candidate.id}`;
  const known = new Set(loaded.map(key));
  const hostMatches = new Set(searched.map(key));
  return [
    ...loaded.filter(
      (candidate) =>
        hostMatches.has(key(candidate)) ||
        needle.length === 0 ||
        candidate.login.toLowerCase().includes(needle) ||
        (candidate.name ?? "").toLowerCase().includes(needle),
    ),
    // The host matched these on its own terms, an email for one, so they are not narrowed again.
    ...searched.filter((candidate) => !known.has(key(candidate))),
  ];
}
