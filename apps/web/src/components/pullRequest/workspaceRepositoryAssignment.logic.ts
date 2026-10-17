import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  PULL_REQUEST_LIST_PROJECT_LIMIT,
  type EnvironmentId,
  type ProjectId,
  type RepositoryIdentity,
} from "@t3tools/contracts";

import type {
  PickableEnvironment,
  PullRequestHostAvailability,
} from "./pullRequestProjectAssignment.logic";

/**
 * Fork: the Pull Requests page's spread of repositories across servers, where a project can be a
 * folder holding several checkouts, as an agentctl Sandbox's working directory is. Numbered
 * Sandboxes of one kind each clone the same repositories, so the page lists each of them from
 * one server and lets a pull request be acted on from any server holding a copy.
 */
export interface RepositoryProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  /** For a folder that is no repository, the checkouts it holds. */
  readonly workspaceRepositories?: ReadonlyArray<RepositoryIdentity> | undefined;
}

/** What one server is asked to list. */
export interface EnvironmentAssignment {
  readonly projectIds: ReadonlyArray<ProjectId>;
  /** Repository keys another server lists, among this one's folders' checkouts. */
  readonly excludeRepositories: ReadonlyArray<string>;
}

/** Empty for an identity stored before it had a key, which then matches nothing. */
function keyOf(identity: Pick<RepositoryIdentity, "canonicalKey">): string {
  return identity.canonicalKey
    ? sourceControlClients.canonicalRepositoryKey(identity.canonicalKey.toLowerCase())
    : "";
}

/** The checkouts a project lists from: its own repository, or a folder's checkouts. */
function checkoutsOf(project: RepositoryProject): ReadonlyArray<RepositoryIdentity> {
  return project.repositoryIdentity != null
    ? [project.repositoryIdentity]
    : (project.workspaceRepositories ?? []);
}

function keysOf(project: RepositoryProject): ReadonlyArray<string> {
  return [...new Set(checkoutsOf(project).map(keyOf))].filter((key) => key !== "");
}

/**
 * Which server lists each repository, by upstream's costs: one that is reachable wins over one
 * that isn't, so a stopped Sandbox doesn't keep a repository the running ones then skip, and one
 * whose host has a provider set up wins over one without; then the preferred server; then the
 * earliest.
 */
function repositoryOwners(
  projects: ReadonlyArray<RepositoryProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  preferredEnvironmentId: EnvironmentId | null | undefined,
  hostAvailability: PullRequestHostAvailability | undefined,
  unreachableEnvironmentIds: ReadonlySet<EnvironmentId>,
): Map<string, EnvironmentId> {
  const order = new Map(environmentIds.map((id, index) => [id, index] as const));
  const unreadable = (project: RepositoryProject, checkout: RepositoryIdentity) => {
    const availability = hostAvailability?.get(project.environmentId);
    // A server reports one host per project, which a folder of several checkouts cannot use.
    const host =
      (project.repositoryIdentity != null
        ? availability?.projectHosts.get(project.id)?.host
        : undefined) ?? hostOf(checkout);
    return host !== null && availability?.hosts.get(host)?.configured === false;
  };
  const rank = (project: RepositoryProject, checkout: RepositoryIdentity) => [
    (unreachableEnvironmentIds.has(project.environmentId) ? 2 : 0) +
      (unreadable(project, checkout) ? 1 : 0),
    project.environmentId === preferredEnvironmentId ? 0 : 1,
    order.get(project.environmentId) ?? Number.MAX_SAFE_INTEGER,
  ];
  const owner = new Map<string, { environmentId: EnvironmentId; rank: ReadonlyArray<number> }>();
  for (const project of projects) {
    if (!order.has(project.environmentId)) continue;
    for (const checkout of checkoutsOf(project)) {
      const key = keyOf(checkout);
      if (key === "") continue;
      const candidate = rank(project, checkout);
      const current = owner.get(key);
      const index = current?.rank.findIndex((value, at) => value !== candidate[at]) ?? -1;
      if (current === undefined || (index !== -1 && candidate[index]! < current.rank[index]!)) {
        owner.set(key, { environmentId: project.environmentId, rank: candidate });
      }
    }
  }
  return new Map([...owner].map(([key, { environmentId }]) => [key, environmentId]));
}

/**
 * Which projects each server lists, and which of its folders' checkouts it skips. A project
 * rooted in a repository another server lists is left out; a folder is kept while any checkout
 * is its own to list. A project with no repository is never de-duplicated, since nothing proves
 * it is a copy of anything.
 */
export function assignRepositoriesToEnvironments(
  projects: ReadonlyArray<RepositoryProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  preferredEnvironmentId?: EnvironmentId | null,
  hostAvailability?: PullRequestHostAvailability,
  unreachableEnvironmentIds: ReadonlySet<EnvironmentId> = new Set(),
): Map<EnvironmentId, EnvironmentAssignment> {
  const owner = repositoryOwners(
    projects,
    environmentIds,
    preferredEnvironmentId,
    hostAvailability,
    unreachableEnvironmentIds,
  );
  const reading = new Set(environmentIds);
  const assignment = new Map<
    EnvironmentId,
    { projectIds: ProjectId[]; excludeRepositories: Set<string> }
  >();
  for (const project of projects) {
    if (!reading.has(project.environmentId)) continue;
    const keys = keysOf(project);
    const others = keys.filter((key) => owner.get(key) !== project.environmentId);
    if (keys.length > 0 && others.length === keys.length) continue;
    let listed = assignment.get(project.environmentId);
    if (listed === undefined) {
      listed = { projectIds: [], excludeRepositories: new Set() };
      assignment.set(project.environmentId, listed);
    }
    listed.projectIds.push(project.id);
    for (const key of others) listed.excludeRepositories.add(key);
  }
  return new Map(
    [...assignment].map(([environmentId, listed]) => [
      environmentId,
      {
        projectIds: listed.projectIds,
        excludeRepositories: [...listed.excludeRepositories].toSorted(),
      },
    ]),
  );
}

/**
 * What each server is asked for, as upstream's pullRequestProjectQueries, with the repositories it
 * skips. A server listing everything it holds is asked without a project filter, so a one-server
 * workspace asks exactly the question it always has.
 */
export function workspacePullRequestQueries(
  projects: ReadonlyArray<RepositoryProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  hostAvailability?: PullRequestHostAvailability,
  unreachableEnvironmentIds?: ReadonlySet<EnvironmentId>,
): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly projectIds?: ReadonlyArray<ProjectId>;
  readonly excludeRepositories?: ReadonlyArray<string>;
}> {
  const assignment = assignRepositoriesToEnvironments(
    projects,
    environmentIds,
    environmentIds[0],
    hostAvailability,
    unreachableEnvironmentIds,
  );
  const totals = new Map<EnvironmentId, number>();
  for (const project of projects) {
    totals.set(project.environmentId, (totals.get(project.environmentId) ?? 0) + 1);
  }
  return environmentIds.flatMap((environmentId) => {
    const listed = assignment.get(environmentId);
    if (listed === undefined) return [];
    const { projectIds, excludeRepositories } = listed;
    const skips = excludeRepositories.length > 0 ? { excludeRepositories } : {};
    if (projectIds.length === totals.get(environmentId)) return [{ environmentId, ...skips }];
    const queries = [];
    for (let offset = 0; offset < projectIds.length; offset += PULL_REQUEST_LIST_PROJECT_LIMIT) {
      queries.push({
        environmentId,
        projectIds: projectIds.slice(offset, offset + PULL_REQUEST_LIST_PROJECT_LIMIT),
        ...skips,
      });
    }
    return queries;
  });
}

function hostOf(identity: RepositoryIdentity): string | null {
  return identity.provider === undefined
    ? null
    : sourceControlClients.changeRequestHost(identity, identity.provider);
}

/** The project's checkout of a pull request's repository, matched the way the server does. */
function checkoutFor(
  project: RepositoryProject,
  pullRequest: { readonly host?: string | undefined; readonly repository: string },
): RepositoryIdentity | undefined {
  const repository = pullRequest.repository.toLowerCase();
  const host = pullRequest.host?.toLowerCase();
  return checkoutsOf(project).find(
    (identity) =>
      sourceControlClients.repositorySelector(identity)?.toLowerCase() === repository &&
      (host === undefined || hostOf(identity) === host),
  );
}

/** Where a project holds a repository: its own root, or a folder's checkout of it. */
function copyIn(project: RepositoryProject, key: string): string | null {
  if (project.repositoryIdentity != null) {
    return keyOf(project.repositoryIdentity) === key ? project.workspaceRoot : null;
  }
  const checkout = project.workspaceRepositories?.find((identity) => keyOf(identity) === key);
  return checkout === undefined ? null : (checkout.rootPath ?? project.workspaceRoot);
}

/**
 * Which servers a pull request could be acted on, the panel's own first, each with its copy of
 * the repository: a project rooted in it, or a folder's checkout. Empty where there is no choice
 * to offer, and the caller then keeps the surface a lone server has always had.
 */
export function resolveRepositoryCopies(
  current: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly host?: string | undefined;
    readonly repository: string;
  },
  projects: ReadonlyArray<RepositoryProject>,
  environments: ReadonlyArray<Pick<PickableEnvironment, "environmentId" | "label" | "machine">>,
): ReadonlyArray<PickableEnvironment> {
  const own = projects.find(
    (project) =>
      project.environmentId === current.environmentId && project.id === current.projectId,
  );
  const ownCheckout =
    own === undefined
      ? undefined
      : own.repositoryIdentity != null
        ? own.repositoryIdentity
        : checkoutFor(own, current);
  const ownEnvironment = environments.find(
    (environment) => environment.environmentId === current.environmentId,
  );
  if (own === undefined || ownCheckout === undefined || ownEnvironment === undefined) return [];
  const key = keyOf(ownCheckout);
  if (key === "") return [];
  const entry = (
    environment: Pick<PickableEnvironment, "environmentId" | "label" | "machine">,
    projectId: ProjectId,
    workspaceRoot: string,
  ): PickableEnvironment => ({
    environmentId: environment.environmentId,
    projectId,
    workspaceRoot,
    label: environment.label,
    ...(environment.machine === undefined ? {} : { machine: environment.machine }),
  });
  const others = environments.flatMap((environment) => {
    if (environment.environmentId === current.environmentId) return [];
    // One entry per server, whichever copy comes first: what is being picked is the server.
    for (const project of projects) {
      if (project.environmentId !== environment.environmentId) continue;
      const workspaceRoot = copyIn(project, key);
      if (workspaceRoot !== null) return [entry(environment, project.id, workspaceRoot)];
    }
    return [];
  });
  if (others.length === 0) return [];
  return [entry(ownEnvironment, own.id, copyIn(own, key) ?? own.workspaceRoot), ...others];
}
