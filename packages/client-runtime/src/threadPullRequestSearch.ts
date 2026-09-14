import {
  threadPullRequestSearchTerms,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import type { OrchestrationThreadShell } from "@t3tools/contracts";

export type ThreadPullRequestSearchTarget = Pick<
  OrchestrationThreadShell,
  "linkedPullRequest" | "branchPullRequest"
> &
  Partial<Pick<OrchestrationThreadShell, "pullRequests">>;

/** Parse once per search, then match either stored PR without fetching provider data. */
export function createThreadPullRequestMatcher(query: string) {
  const trimmed = query.trim();
  const number = /^#?\d+$/.test(trimmed) ? Number(trimmed.replace(/^#/, "")) : null;
  const normalizedQuery = trimmed.toLocaleLowerCase();
  return (thread: ThreadPullRequestSearchTarget): boolean => {
    if (number === null) {
      return (
        normalizedQuery.length > 0 &&
        threadPullRequestSearchTerms(thread).some((term) =>
          term.toLocaleLowerCase().includes(normalizedQuery),
        )
      );
    }
    if (thread.pullRequests && thread.pullRequests.length > 0) {
      return visibleThreadPullRequests(thread.pullRequests).some((pr) => pr.number === number);
    }
    return (
      thread.linkedPullRequest?.number === number || thread.branchPullRequest?.number === number
    );
  };
}
