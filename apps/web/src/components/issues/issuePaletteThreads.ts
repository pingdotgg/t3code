import type { EnvironmentId, IssueKey, IssueLinkedThread } from "@t3tools/contracts";
import { useMemo } from "react";

import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { issueLinkEnvironment } from "~/state/issueLinks";
import { issueDetail } from "~/state/issues";
import { createMergedEnvironmentQuery } from "~/state/pullRequests";
import { useDebouncedValue } from "~/state/queries";
import { environmentIdsWithCapability, issueKey } from "./issueList.logic";
import { useIssuePaletteSource } from "./issuePaletteStore";
import { paletteIssueDetailTarget, paletteIssueThreadTargets } from "./issuePaletteThreads.logic";

const LOOKUP_DEBOUNCE_MS = 300;

const useThreadsForIssuesQuery = createMergedEnvironmentQuery(
  "web-palette:threads-for-issue",
  issueLinkEnvironment.threadsForIssues,
);
const useIssueDetailQuery = createMergedEnvironmentQuery("web-palette:issue-detail", issueDetail);

/**
 * Threads linked to the Issue the palette query names, per server, however they were linked
 * (by hand, by an agent, started from the Issue, by branch, by a closing pull request). Read once
 * the query settles. Closing pull requests come from the loaded Issues list, else from one Issue
 * read for `owner/repo#N` or a URL; a bare `#N` the list does not hold finds stored and branch
 * links only.
 */
export function usePaletteIssueThreads(query: string): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<IssueLinkedThread>;
}> {
  const settled = useDebouncedValue(query, LOOKUP_DEBOUNCE_MS);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const source = useIssuePaletteSource();
  const loaded = useMemo(
    () => new Map((source?.entries ?? []).map((entry) => [issueKey(entry), entry] as const)),
    [source],
  );
  const detailTargets = useMemo(() => {
    const target = paletteIssueDetailTarget(
      settled,
      projects,
      environmentIdsWithCapability(environments, "issues"),
      (issue) => loaded.has(issueKey(issue)),
    );
    return target === null ? [] : [target];
  }, [environments, loaded, projects, settled]);
  const detail = useIssueDetailQuery(detailTargets);
  const targets = useMemo(() => {
    const read = detail.values[0]?.[1] ?? null;
    const closingPullRequestsOf = (issue: IssueKey) =>
      loaded.get(issueKey(issue))?.closingPullRequests ??
      (read !== null && issueKey(read) === issueKey(issue) ? read.closingPullRequests : []);
    return paletteIssueThreadTargets(
      settled,
      projects,
      environmentIdsWithCapability(environments, "issueLinks"),
      closingPullRequestsOf,
    );
  }, [detail.values, environments, loaded, projects, settled]);
  const result = useThreadsForIssuesQuery(targets);
  return useMemo(() => {
    // Stale answers for an earlier query never show under a new one.
    if (settled !== query) return [];
    const byEnvironment = new Map<EnvironmentId, Map<string, IssueLinkedThread>>();
    for (const [environmentId, answer] of result.values) {
      const threads = byEnvironment.get(environmentId) ?? new Map();
      for (const issue of answer.issues) {
        for (const thread of issue.threads) threads.set(thread.id, thread);
      }
      byEnvironment.set(environmentId, threads);
    }
    return [...byEnvironment]
      .filter(([, threads]) => threads.size > 0)
      .map(([environmentId, threads]) => ({ environmentId, threads: [...threads.values()] }));
  }, [query, result.values, settled]);
}
