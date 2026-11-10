import type {
  PullRequestState,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

/** Tombstones prevent sync from re-adding hidden members. */
export function visibleThreadPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<ThreadPullRequestLink> {
  return links.filter((link) => link.source !== "stack-dismissed");
}

export interface ThreadPullRequestIdentityFilter {
  readonly number?: number | undefined;
  readonly repository?: string | undefined;
  readonly url?: string | undefined;
}

const LIST_PULL_REQUEST_NUMBER = /^#?(\d+)$/;
const LIST_PULL_REQUEST_REPO_NUMBER = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
/** GitHub `/pull/n`, Azure `/pullrequest/n`, GitLab `/-/merge_requests/n`. */
const LIST_PULL_REQUEST_URL = /^\S*\/(?:pulls?|pullrequest|-\/merge_requests)\/\d+(?:[/?#]\S*)?$/i;
const LIST_PULL_REQUEST_STATES = new Set<PullRequestState>(["open", "closed", "merged"]);

/** Parses `t3_thread_list`'s `pullRequest` string: state, `#n` / `n`, `owner/repo#n`, or a pull URL. */
export function parseThreadListPullRequestFilter(value: string): {
  readonly pullRequestStates?: ReadonlyArray<PullRequestState>;
  readonly pullRequest?: ThreadPullRequestIdentityFilter;
} | null {
  const trimmed = value.trim();
  const state = trimmed.toLowerCase();
  if (LIST_PULL_REQUEST_STATES.has(state as PullRequestState)) {
    return { pullRequestStates: [state as PullRequestState] };
  }
  const numberMatch = LIST_PULL_REQUEST_NUMBER.exec(trimmed);
  if (numberMatch !== null) return { pullRequest: { number: Number(numberMatch[1]) } };
  const repoNumberMatch = LIST_PULL_REQUEST_REPO_NUMBER.exec(trimmed);
  if (repoNumberMatch !== null) {
    return {
      pullRequest: { repository: repoNumberMatch[1], number: Number(repoNumberMatch[2]) },
    };
  }
  if (LIST_PULL_REQUEST_URL.test(trimmed)) return { pullRequest: { url: trimmed } };
  return null;
}

const DIGIT = /\d/;

/** A pasted link may continue past the stored URL: ".../pull/22889/files". */
function pullRequestUrlMatches(query: string, url: string): boolean {
  const needle = query.toLowerCase();
  const haystack = url.toLowerCase();
  const at = haystack.indexOf(needle);
  if (at !== -1) {
    const end = at + needle.length;
    return end >= haystack.length || !DIGIT.test(haystack[end] ?? "");
  }
  return needle.startsWith(haystack) && !DIGIT.test(needle[haystack.length] ?? "");
}

/** Whether a visible link matches an MCP list pullRequest identity filter. */
export function threadPullRequestMatchesIdentity(
  link: Pick<ThreadPullRequestLink, "number" | "repository" | "url">,
  filter: ThreadPullRequestIdentityFilter,
): boolean {
  if (filter.number !== undefined && link.number !== filter.number) return false;
  if (
    filter.repository !== undefined &&
    link.repository.toLowerCase() !== filter.repository.toLowerCase()
  ) {
    return false;
  }
  if (filter.url !== undefined && !pullRequestUrlMatches(filter.url, link.url)) return false;
  return filter.number !== undefined || filter.url !== undefined;
}

export function threadMatchesPullRequestListFilters(
  links: ReadonlyArray<ThreadPullRequestLink> | undefined,
  filters: {
    readonly pullRequestStates?: ReadonlyArray<PullRequestState> | undefined;
    readonly pullRequest?: ThreadPullRequestIdentityFilter | undefined;
  },
): boolean {
  const states =
    filters.pullRequestStates !== undefined && filters.pullRequestStates.length > 0
      ? new Set(filters.pullRequestStates)
      : undefined;
  const identity = filters.pullRequest;
  if (states === undefined && identity === undefined) return true;
  return visibleThreadPullRequests(links ?? []).some(
    (link) =>
      (states === undefined || (link.snapshot?.state != null && states.has(link.snapshot.state))) &&
      (identity === undefined || threadPullRequestMatchesIdentity(link, identity)),
  );
}

function latestUpdatedAt(link: ThreadPullRequestLink): number {
  const value = link.snapshot?.updatedAt ?? link.linkedAt;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

export interface ThreadSearchPullRequest {
  readonly number: number;
  readonly title: string | null;
  /** `owner/repo#123` and the pull request URL, matched only by a whole query. */
  readonly references: ReadonlyArray<string>;
}

const SEARCHED_PULL_REQUEST_TITLES = 3;

/** Pull requests thread search matches by number, title, and reference. */
export function threadSearchPullRequests(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null | undefined;
}): ThreadSearchPullRequest[] {
  const entry = (
    link: Pick<ThreadLinkedPullRequest, "number" | "repository" | "url">,
    title: string | null,
  ): ThreadSearchPullRequest => ({
    number: link.number,
    title,
    references: [`${link.repository}#${link.number}`, link.url],
  });
  const branch = thread.branchPullRequest ? [entry(thread.branchPullRequest, null)] : [];
  if (thread.pullRequests !== undefined && thread.pullRequests.length > 0) {
    // Every pull request matches by number and link, but only the newest few
    // by title: a triage thread linked to dozens would match almost any word.
    const newestFirst = [...visibleThreadPullRequests(thread.pullRequests)].sort(
      (left, right) => latestUpdatedAt(right) - latestUpdatedAt(left),
    );
    return branch.concat(
      newestFirst.map((link, index) =>
        entry(link, index < SEARCHED_PULL_REQUEST_TITLES ? (link.snapshot?.title ?? null) : null),
      ),
    );
  }
  return thread.linkedPullRequest ? branch.concat(entry(thread.linkedPullRequest, null)) : branch;
}

export function threadPullRequestSearchTerms(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null | undefined;
}): string[] {
  return threadSearchPullRequests(thread).flatMap((pullRequest) => [
    `#${pullRequest.number}`,
    ...pullRequest.references,
    ...(pullRequest.title ? [pullRequest.title] : []),
  ]);
}

const PULL_REQUEST_NUMBER_QUERY = /^#?\d+$/;
const PULL_REQUEST_REPO_NUMBER_QUERY = /^[\w.-]+\/[\w.-]+#\d+$/;
const PULL_REQUEST_URL_NUMBER = LIST_PULL_REQUEST_URL;
/** Same floor as palette reference matching: short URL prefixes hit too many threads. */
const PULL_REQUEST_REFERENCE_PREFIX_MIN = 8;
/** Same stripping as palette field queries for numbered pull-request lookups. */
const PULL_REQUEST_QUERY_PREFIX = /^(?:pr|pull request|pull)\s*(?=#?\d)/i;

function pullRequestIdentityQuery(normalizedQuery: string): string {
  return normalizedQuery.trim().replace(PULL_REQUEST_QUERY_PREFIX, "").replace(/^#\s*/, "#");
}

/**
 * True when the query is a PR number, #n, owner/repo#n, or a pull URL — not free
 * text. Message search should stay off for these so mention-only threads do not
 * crowd out the thread that actually links the PR.
 */
export function isPullRequestIdentityQuery(normalizedQuery: string): boolean {
  const query = pullRequestIdentityQuery(normalizedQuery);
  return (
    PULL_REQUEST_NUMBER_QUERY.test(query.replace(/^#/, "")) ||
    PULL_REQUEST_REPO_NUMBER_QUERY.test(query) ||
    PULL_REQUEST_URL_NUMBER.test(query)
  );
}

function pullRequestReferenceMatches(normalizedQuery: string, reference: string): boolean {
  if (normalizedQuery.length < PULL_REQUEST_REFERENCE_PREFIX_MIN) return false;
  const folded = reference.toLowerCase();
  const at = folded.indexOf(normalizedQuery);
  if (at !== -1) {
    const end = at + normalizedQuery.length;
    return end >= folded.length || !DIGIT.test(folded[end] ?? "");
  }
  return (
    DIGIT.test(normalizedQuery) &&
    normalizedQuery.startsWith(folded) &&
    !DIGIT.test(normalizedQuery[folded.length] ?? "")
  );
}

export interface MatchedThreadSearchPullRequest {
  readonly number: number;
  readonly repository: string;
  readonly url: string;
}

/** The linked PR this identity query matched, or null when only title/text matched. */
export function matchThreadSearchPullRequest(
  normalizedQuery: string,
  pullRequests: ReadonlyArray<ThreadSearchPullRequest>,
): MatchedThreadSearchPullRequest | null {
  const query = pullRequestIdentityQuery(normalizedQuery);
  const numberText = query.replace(/^#/, "");
  if (PULL_REQUEST_NUMBER_QUERY.test(numberText)) {
    const number = Number(numberText);
    const match = pullRequests.find((pullRequest) => pullRequest.number === number);
    return match ? matchedPullRequest(match) : null;
  }
  for (const pullRequest of pullRequests) {
    if (pullRequest.references.some((reference) => pullRequestReferenceMatches(query, reference))) {
      return matchedPullRequest(pullRequest);
    }
  }
  return null;
}

function matchedPullRequest(pullRequest: ThreadSearchPullRequest): MatchedThreadSearchPullRequest {
  const repoRef = pullRequest.references.find((reference) => reference.includes("#"));
  const url =
    pullRequest.references.find((reference) => /:\/\//.test(reference)) ??
    pullRequest.references[0] ??
    "";
  return {
    number: pullRequest.number,
    repository: repoRef?.slice(0, repoRef.indexOf("#")) ?? "",
    url,
  };
}
