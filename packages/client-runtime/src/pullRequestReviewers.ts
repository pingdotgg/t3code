import type {
  PullRequestReviewerCandidate,
  PullRequestReviewerCandidateList,
} from "@t3tools/contracts";

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

export interface ReviewerSearchInput {
  readonly loaded: PullRequestReviewerCandidateList | null;
  /** The host declared `reviewers.searchCandidates`. */
  readonly searchable: boolean;
  readonly query: string;
  readonly debouncedQuery: string;
}

/** What to ask the host for, or null when the loaded page already answers the query. */
export function hostReviewerQuery(input: ReviewerSearchInput): string | null {
  const debounced = input.debouncedQuery.trim();
  return input.searchable && input.loaded?.truncated === true && debounced.length > 0
    ? debounced
    : null;
}

/**
 * Why the list may be missing people: `unsearchable` hosts cannot be asked, `searchable` ones
 * can once something is typed, and a search that ran either `failed` or was `truncated` itself.
 */
export type ReviewerTruncation =
  | "unsearchable"
  | "searchable"
  | "search-failed"
  | "search-truncated";

export function reviewerCandidateView(
  input: ReviewerSearchInput & {
    readonly search: {
      readonly data: PullRequestReviewerCandidateList | null;
      readonly isPending: boolean;
      readonly error: string | null;
    };
  },
): {
  readonly candidates: ReadonlyArray<PullRequestReviewerCandidate>;
  /** Nothing matches yet and the host has not answered, which is not "nobody matches". */
  readonly searchPending: boolean;
  readonly searchError: string | null;
  readonly truncation: ReviewerTruncation | null;
} {
  const query = input.query.trim();
  const hostQuery = hostReviewerQuery(input);
  // Only once the debounce has caught up, or rows matching the previous text would linger.
  const searched = hostQuery !== null && hostQuery === query;
  const candidates = mergeReviewerCandidates(
    input.loaded?.candidates ?? [],
    searched ? (input.search.data?.candidates ?? []) : [],
    query,
  );
  const searching = input.searchable && input.loaded?.truncated === true && query.length > 0;
  const searchError = searched ? input.search.error : null;
  const truncation: ReviewerTruncation | null =
    input.loaded?.truncated !== true
      ? null
      : !input.searchable
        ? "unsearchable"
        : query.length === 0
          ? "searchable"
          : !searched
            ? null
            : searchError !== null
              ? "search-failed"
              : input.search.data?.truncated === true
                ? "search-truncated"
                : null;
  return {
    candidates,
    searchPending: candidates.length === 0 && searching && (!searched || input.search.isPending),
    searchError,
    truncation,
  };
}
