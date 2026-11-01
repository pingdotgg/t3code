import type { ThreadLinkedPullRequest, ThreadPullRequestLink } from "@t3tools/contracts";

/** Tombstones prevent sync from re-adding hidden members. */
export function visibleThreadPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<ThreadPullRequestLink> {
  return links.filter((link) => link.source !== "stack-dismissed");
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
