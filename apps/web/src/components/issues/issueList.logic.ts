import type {
  EnvironmentId,
  IssueLink,
  IssueListCursors,
  IssueListEntry,
  IssueListRepository,
  IssueListResult,
  IssueListSort,
  IssuePullRequest,
} from "@t3tools/contracts";

export interface EnvironmentIssueEntry extends IssueListEntry {
  /** The server that read the row, which is also the one its actions go to. */
  readonly environmentId: EnvironmentId;
}

export interface EnvironmentIssueRepository extends IssueListRepository {
  readonly environmentId: EnvironmentId;
}

export interface MergedIssueList {
  readonly entries: ReadonlyArray<EnvironmentIssueEntry>;
  readonly repositories: ReadonlyArray<EnvironmentIssueRepository>;
  /** Repositories on other forges, once each however many servers or worktrees hold them. */
  readonly unsupported: ReadonlyArray<{ readonly host: string; readonly repositoryCount: number }>;
  readonly errors: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly host: string;
    readonly message: string;
  }>;
  /** The newest continuation per server; absent once a server has nothing more. */
  readonly nextCursors: ReadonlyMap<EnvironmentId, IssueListCursors>;
  /** Thread-linked pull requests any server read, by `issueKey`. */
  readonly linkedPullRequests: ReadonlyMap<string, IssuePullRequest>;
  /**
   * Per `issueKey`, the lowercase logins of every server that listed the Issue: a review mark
   * any of them posted is trusted.
   */
  readonly trustedLogins: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface IssueListFilters {
  /** A `repositoryKey`. */
  readonly repository?: string | undefined;
  /** Every one must be on the Issue. */
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly milestone?: string | undefined;
  /** `"none"` for top-level Issues, or the `issueKey` of a parent for its children. */
  readonly parent?: string | undefined;
}

/**
 * Servers that advertise a fork capability, sorted. Upstream and older servers answer `issues.*`
 * with an unknown-tag error, so the Issues list and its entry points ask only these.
 */
export function environmentIdsWithCapability(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly serverConfig: {
      readonly environment: {
        readonly capabilities: { readonly issues?: boolean; readonly issueLinks?: boolean };
      };
    } | null;
  }>,
  capability: "issues" | "issueLinks",
): ReadonlyArray<EnvironmentId> {
  return environments
    .filter(
      (environment) => environment.serverConfig?.environment.capabilities[capability] === true,
    )
    .map((environment) => environment.environmentId)
    .toSorted((left, right) => left.localeCompare(right));
}

export function repositoryKey(host: string, repository: string): string {
  return `${host.toLowerCase()} ${repository.toLowerCase()}`;
}

export function issueKey(issue: Pick<IssueLink, "host" | "repository" | "number">): string {
  return `${repositoryKey(issue.host, issue.repository)}#${issue.number}`;
}

/**
 * The answers of every server and every page already loaded, in the order they were asked. Two
 * servers with one repository return the same Issue; the first answer keeps it. A later page of a
 * server replaces its continuation, which is how "load more" walks forward.
 */
export function mergeIssueLists(
  values: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
): MergedIssueList | null {
  if (values.length === 0) return null;
  const entries = new Map<string, EnvironmentIssueEntry>();
  const repositories = new Map<string, EnvironmentIssueRepository>();
  const unsupported = new Map<string, number>();
  const unsupportedSeen = new Set<string>();
  const errors: Array<MergedIssueList["errors"][number]> = [];
  const nextCursors = new Map<EnvironmentId, IssueListCursors>();
  const linkedPullRequests = new Map<string, IssuePullRequest>();
  const trustedLogins = new Map<string, Set<string>>();
  for (const [environmentId, result] of values) {
    const viewers = new Map(
      result.viewers.map(({ host, login }) => [host.toLowerCase(), login.toLowerCase()]),
    );
    for (const entry of result.entries) {
      const key = issueKey(entry);
      if (!entries.has(key)) entries.set(key, { ...entry, environmentId });
      const login = viewers.get(entry.host.toLowerCase());
      if (login === undefined || login.length === 0) continue;
      const logins = trustedLogins.get(key) ?? new Set<string>();
      logins.add(login);
      trustedLogins.set(key, logins);
    }
    for (const pullRequest of result.linkedPullRequests) {
      const key = issueKey(pullRequest);
      if (!linkedPullRequests.has(key)) linkedPullRequests.set(key, pullRequest);
    }
    for (const repository of result.repositories) {
      const key = repositoryKey(repository.host, repository.repository);
      if (!repositories.has(key)) repositories.set(key, { ...repository, environmentId });
    }
    // Keyed like the GitHub repositories: continuation pages and other servers repeat them.
    for (const { host, repository } of result.unsupported) {
      const key = repositoryKey(host, repository);
      if (unsupportedSeen.has(key)) continue;
      unsupportedSeen.add(key);
      unsupported.set(host.toLowerCase(), (unsupported.get(host.toLowerCase()) ?? 0) + 1);
    }
    for (const error of result.errors) errors.push({ environmentId, ...error });
    if (Object.keys(result.nextCursors).length > 0) {
      nextCursors.set(environmentId, result.nextCursors);
    } else {
      nextCursors.delete(environmentId);
    }
  }
  return {
    entries: [...entries.values()],
    repositories: [...repositories.values()],
    unsupported: [...unsupported].map(([host, repositoryCount]) => ({ host, repositoryCount })),
    errors,
    nextCursors,
    linkedPullRequests,
    trustedLogins,
  };
}

export function matchesIssueFilters(entry: IssueListEntry, filters: IssueListFilters): boolean {
  if (
    filters.repository !== undefined &&
    repositoryKey(entry.host, entry.repository) !== filters.repository
  ) {
    return false;
  }
  if (filters.labels !== undefined && filters.labels.length > 0) {
    const names = new Set(entry.labels.map((label) => label.name.toLowerCase()));
    if (!filters.labels.every((label) => names.has(label.toLowerCase()))) return false;
  }
  if (
    filters.milestone !== undefined &&
    entry.milestone?.toLowerCase() !== filters.milestone.toLowerCase()
  ) {
    return false;
  }
  if (filters.parent === "none") return entry.parent === null;
  if (filters.parent !== undefined) {
    return entry.parent !== null && issueKey(entry.parent) === filters.parent;
  }
  return true;
}

/** Newest first for every key; ties fall back to repository and number so the order is stable. */
export function sortIssues<Entry extends IssueListEntry>(
  entries: ReadonlyArray<Entry>,
  sort: IssueListSort,
): ReadonlyArray<Entry> {
  const time = (entry: Entry) => Date.parse(sort === "updated" ? entry.updatedAt : entry.createdAt);
  return entries.toSorted((left, right) => {
    const primary =
      sort === "number" ? right.number - left.number : (time(right) || 0) - (time(left) || 0);
    if (primary !== 0) return primary;
    const repository = left.repository.localeCompare(right.repository);
    return repository !== 0 ? repository : right.number - left.number;
  });
}

export interface IssueFacets {
  readonly labels: ReadonlyArray<{ readonly name: string; readonly color: string }>;
  readonly milestones: ReadonlyArray<string>;
  /** Issues that are the parent of at least one loaded Issue. */
  readonly parents: ReadonlyArray<IssueLink>;
}

/** What the filter menus offer: only values the loaded rows actually carry, most used first. */
export function collectIssueFacets(entries: ReadonlyArray<IssueListEntry>): IssueFacets {
  const labels = new Map<string, { name: string; color: string; count: number }>();
  const milestones = new Map<string, number>();
  const parents = new Map<string, IssueLink>();
  for (const entry of entries) {
    for (const label of entry.labels) {
      const key = label.name.toLowerCase();
      const held = labels.get(key);
      if (held === undefined) labels.set(key, { ...label, count: 1 });
      else held.count += 1;
    }
    if (entry.milestone !== null) {
      milestones.set(entry.milestone, (milestones.get(entry.milestone) ?? 0) + 1);
    }
    if (entry.parent !== null) parents.set(issueKey(entry.parent), entry.parent);
  }
  return {
    labels: [...labels.values()]
      .toSorted((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .map(({ name, color }) => ({ name, color })),
    milestones: [...milestones]
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([name]) => name),
    parents: [...parents.values()].toSorted(
      (left, right) =>
        left.repository.localeCompare(right.repository) || right.number - left.number,
    ),
  };
}

export interface IssueTreeNode {
  readonly key: string;
  /** The loaded row, or null for a sub-Issue the list does not hold. */
  readonly entry: EnvironmentIssueEntry | null;
  readonly link: IssueLink;
  /** Its repository belongs to none of the user's projects. */
  readonly outsideProjects: boolean;
  readonly children: ReadonlyArray<IssueTreeNode>;
  /** Sub-Issues GitHub has beyond the ones it sent with the row. */
  readonly unlistedChildCount: number;
}

/**
 * The parent tree of the rows on the page. An Issue whose parent is on the page sits under it;
 * every other Issue is a root, in the order given. Each parent also shows the sub-Issues the page
 * does not hold, including ones in other repositories, as link-only nodes marked when their
 * repository is outside the user's projects.
 */
export function buildIssueTree(
  entries: ReadonlyArray<EnvironmentIssueEntry>,
  projectRepositories: ReadonlySet<string>,
): ReadonlyArray<IssueTreeNode> {
  const byKey = new Map(entries.map((entry) => [issueKey(entry), entry] as const));
  const childrenOf = new Map<string, Array<string>>();
  for (const entry of entries) {
    if (entry.parent === null) continue;
    const parentKey = issueKey(entry.parent);
    if (!byKey.has(parentKey)) continue;
    const children = childrenOf.get(parentKey) ?? [];
    children.push(issueKey(entry));
    childrenOf.set(parentKey, children);
  }
  const outside = (link: IssueLink) =>
    !projectRepositories.has(repositoryKey(link.host, link.repository));

  const build = (link: IssueLink, visiting: ReadonlySet<string>): IssueTreeNode => {
    const key = issueKey(link);
    const entry = byKey.get(key) ?? null;
    const path = new Set(visiting).add(key);
    const childKeys: Array<string> = [];
    const childLinks = new Map<string, IssueLink>();
    for (const child of entry?.subIssues ?? []) {
      const childKey = issueKey(child);
      if (childLinks.has(childKey)) continue;
      childKeys.push(childKey);
      childLinks.set(childKey, child);
    }
    // A loaded child GitHub left off the parent's first page still belongs under it.
    for (const childKey of childrenOf.get(key) ?? []) {
      if (childLinks.has(childKey)) continue;
      childKeys.push(childKey);
      childLinks.set(childKey, byKey.get(childKey)!);
    }
    const children = childKeys
      .filter((childKey) => !path.has(childKey))
      .map((childKey) => build(byKey.get(childKey) ?? childLinks.get(childKey)!, path));
    return {
      key,
      entry,
      link: entry ?? link,
      outsideProjects: outside(link),
      children,
      unlistedChildCount: Math.max(0, (entry?.subIssueCount ?? 0) - (entry?.subIssues.length ?? 0)),
    };
  };

  return entries
    .filter((entry) => entry.parent === null || !byKey.has(issueKey(entry.parent)))
    .map((entry) => build(entry, new Set()));
}
