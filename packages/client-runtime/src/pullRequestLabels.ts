import type { PullRequestLabelCandidate, PullRequestLabelCandidateList } from "@t3tools/contracts";

function haystack(candidate: PullRequestLabelCandidate): string {
  return `${candidate.name}\n${candidate.description ?? ""}`.toLowerCase();
}

// Loaded rows retain the applied state updated by mutations.
export function mergeLabelCandidates(
  loaded: ReadonlyArray<PullRequestLabelCandidate>,
  searched: ReadonlyArray<PullRequestLabelCandidate>,
  query: string,
): ReadonlyArray<PullRequestLabelCandidate> {
  const needle = query.trim().toLowerCase();
  const known = new Set(loaded.map((candidate) => candidate.name));
  const hostMatches = new Set(searched.map((candidate) => candidate.name));
  return [
    ...loaded.filter(
      (candidate) =>
        hostMatches.has(candidate.name) ||
        needle.length === 0 ||
        haystack(candidate).includes(needle),
    ),
    // The host matched these on its own terms, a description for one, so they are not narrowed.
    ...searched.filter((candidate) => !known.has(candidate.name)),
  ];
}

export interface LabelSearchInput {
  readonly loaded: PullRequestLabelCandidateList | null;
  /** The host declared `labels.searchLabels`. */
  readonly searchable: boolean;
  readonly query: string;
  readonly debouncedQuery: string;
}

/** What to ask the host for, or null when the loaded page already answers the query. */
export function hostLabelQuery(input: LabelSearchInput): string | null {
  const debounced = input.debouncedQuery.trim();
  return input.searchable && input.loaded?.truncated === true && debounced.length > 0
    ? debounced
    : null;
}

/**
 * Why the list may be missing labels: `unsearchable` hosts cannot be asked, `searchable` ones
 * can once something is typed, and a search that ran either `failed` or was `truncated` itself.
 */
export type LabelTruncation = "unsearchable" | "searchable" | "search-failed" | "search-truncated";

export function labelCandidateView(
  input: LabelSearchInput & {
    readonly search: {
      readonly data: PullRequestLabelCandidateList | null;
      readonly isPending: boolean;
      readonly error: string | null;
    };
  },
): {
  readonly candidates: ReadonlyArray<PullRequestLabelCandidate>;
  /** Nothing matches yet and the host has not answered, which is not "nobody matches". */
  readonly searchPending: boolean;
  readonly searchError: string | null;
  readonly truncation: LabelTruncation | null;
} {
  const query = input.query.trim();
  const hostQuery = hostLabelQuery(input);
  // Only once the debounce has caught up, or rows matching the previous text would linger.
  const searched = hostQuery !== null && hostQuery === query;
  const candidates = mergeLabelCandidates(
    input.loaded?.candidates ?? [],
    searched ? (input.search.data?.candidates ?? []) : [],
    query,
  );
  const searching = input.searchable && input.loaded?.truncated === true && query.length > 0;
  const searchError = searched ? input.search.error : null;
  const truncation: LabelTruncation | null =
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
