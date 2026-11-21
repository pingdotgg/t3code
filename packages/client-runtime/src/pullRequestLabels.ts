import type { PullRequestLabelCandidate, PullRequestLabelCandidateList } from "@t3tools/contracts";

function matches(candidate: PullRequestLabelCandidate, needle: string): boolean {
  return (
    needle.length === 0 ||
    candidate.name.toLowerCase().includes(needle) ||
    (candidate.description ?? "").toLowerCase().includes(needle)
  );
}

/** What to ask the host for, or null when the loaded page already holds every label. */
export function hostLabelQuery(input: {
  readonly loaded: PullRequestLabelCandidateList | null;
  readonly debouncedQuery: string;
}): string | null {
  const debounced = input.debouncedQuery.trim();
  return input.loaded?.truncated === true && debounced.length > 0 ? debounced : null;
}

export function labelCandidateView(input: {
  readonly loaded: PullRequestLabelCandidateList | null;
  readonly query: string;
  readonly debouncedQuery: string;
  readonly search: {
    readonly data: PullRequestLabelCandidateList | null;
    readonly isPending: boolean;
  };
}): {
  readonly candidates: ReadonlyArray<PullRequestLabelCandidate>;
  /** Nothing loaded matches and the host has not answered yet, which is not "no label matches". */
  readonly searchPending: boolean;
  readonly truncated: boolean;
} {
  const query = input.query.trim();
  const hostQuery = hostLabelQuery(input);
  // Only once the debounce has caught up, or labels matching the previous text would linger.
  const searched = hostQuery !== null && hostQuery === query ? (input.search.data ?? null) : null;
  const listed = searched ?? input.loaded;
  const needle = query.toLowerCase();
  const candidates = (listed?.candidates ?? []).filter((candidate) => matches(candidate, needle));
  return {
    candidates,
    searchPending:
      candidates.length === 0 &&
      input.loaded?.truncated === true &&
      query.length > 0 &&
      searched === null &&
      (hostQuery !== query || input.search.isPending),
    truncated: listed?.truncated === true,
  };
}

/**
 * Whether the host has a label applied, for diffing picks on close. Where the first page and a
 * search disagree, what the user saw when picking it decides, so the pick is still sent.
 */
export function labelAppliedOnHost(
  lists: ReadonlyArray<PullRequestLabelCandidateList | null>,
  picked: PullRequestLabelCandidate,
): boolean {
  const held = lists.flatMap(
    (list) => list?.candidates.filter((entry) => entry.name === picked.name) ?? [],
  );
  const first = held[0];
  return first !== undefined && held.every((entry) => entry.isApplied === first.isApplied)
    ? first.isApplied
    : picked.isApplied;
}
