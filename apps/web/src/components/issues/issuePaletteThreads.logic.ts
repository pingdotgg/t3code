import {
  type EnvironmentId,
  type IssueClosingPullRequest,
  type IssueKey,
  type IssueRef,
  type ThreadsForIssuesInput,
  gitHubRepositoryOf,
  parseIssueUrl,
} from "@t3tools/contracts";

/** Repositories a bare `#N` is looked up in, per server. */
const MAX_REPOSITORIES = 20;

/** What a palette query names as an Issue: `#N`, `owner/repo#N` or an Issue URL. */
export function parsePaletteIssueReference(query: string): {
  readonly repository: string | null;
  readonly host: string | null;
  readonly number: number;
} | null {
  const trimmed = query.trim();
  const url = parseIssueUrl(trimmed);
  if (url !== null) return url;
  const match = /^(?:([\w.-]+\/[\w.-]+))?#(\d{1,9})$/u.exec(trimmed);
  if (match === null) return null;
  const number = Number(match[2]);
  return number < 1 ? null : { repository: match[1]?.toLowerCase() ?? null, host: null, number };
}

type PaletteProject = {
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?:
    | { readonly canonicalKey: string; readonly provider?: string | undefined }
    | null
    | undefined;
};

/**
 * One `threadsForIssues` read per server that keeps Issue links, for the Issue the query names:
 * in that repository, or for a bare `#N` in each of the server's GitHub project repositories (at
 * most 20). Each Issue carries the closing pull requests `closingPullRequestsOf` knows, so threads
 * linked only through one are found too. Empty when the query names no Issue.
 */
export function paletteIssueThreadTargets(
  query: string,
  projects: ReadonlyArray<PaletteProject>,
  linkEnvironments: ReadonlyArray<EnvironmentId>,
  closingPullRequestsOf: (issue: IssueKey) => ReadonlyArray<IssueClosingPullRequest> = () => [],
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly input: ThreadsForIssuesInput }> {
  const reference = parsePaletteIssueReference(query);
  if (reference === null) return [];
  return linkEnvironments.flatMap((environmentId) => {
    const repositories = new Map<string, IssueKey>();
    for (const project of projects) {
      if (project.environmentId !== environmentId) continue;
      const repository = gitHubRepositoryOf(project.repositoryIdentity);
      if (repository === null) continue;
      if (reference.repository !== null && repository.repository !== reference.repository) continue;
      if (reference.host !== null && repository.host !== reference.host) continue;
      const key = `${repository.host}/${repository.repository}`;
      if (!repositories.has(key)) {
        repositories.set(key, { ...repository, number: reference.number });
      }
    }
    // A named repository no project here checks out can still have links on this server.
    if (repositories.size === 0 && reference.repository !== null) {
      repositories.set("named", {
        host: reference.host ?? "github.com",
        repository: reference.repository,
        number: reference.number,
      });
    }
    const issues = [...repositories.values()].slice(0, MAX_REPOSITORIES).map((issue) => ({
      ...issue,
      closingPullRequests: closingPullRequestsOf(issue).map(({ repository, number }) => ({
        repository,
        number,
      })),
    }));
    return issues.length === 0 ? [] : [{ environmentId, input: { issues } }];
  });
}

/**
 * The one Issue read that supplies closing pull requests for `owner/repo#N` or an Issue URL the
 * loaded list does not hold: on a server that lists Issues and has a checkout on the Issue's host,
 * one of that repository when there is one. Null for a bare `#N`, a loaded Issue, or no server.
 */
export function paletteIssueDetailTarget(
  query: string,
  projects: ReadonlyArray<PaletteProject>,
  issuesEnvironments: ReadonlyArray<EnvironmentId>,
  isLoaded: (issue: IssueKey) => boolean,
): { readonly environmentId: EnvironmentId; readonly input: IssueRef } | null {
  const reference = parsePaletteIssueReference(query);
  if (reference === null || reference.repository === null) return null;
  const host = reference.host ?? "github.com";
  const issue = { host, repository: reference.repository, number: reference.number };
  if (isLoaded(issue)) return null;
  const onHost = projects.flatMap((project) => {
    const repository = gitHubRepositoryOf(project.repositoryIdentity);
    return repository !== null &&
      repository.host === host &&
      issuesEnvironments.includes(project.environmentId)
      ? [{ environmentId: project.environmentId, repository: repository.repository }]
      : [];
  });
  const server = onHost.find((candidate) => candidate.repository === issue.repository) ?? onHost[0];
  return server === undefined ? null : { environmentId: server.environmentId, input: issue };
}
