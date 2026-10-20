import {
  pullRequestHostOf,
  PULL_REQUEST_LIST_PROJECT_LIMIT,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectId,
  type PullRequestProviderSummary,
  type RepositoryIdentity,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

export interface AssignableProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?:
    | Partial<Pick<RepositoryIdentity, "canonicalKey" | "provider" | "locator">>
    | null
    | undefined;
}

export type PullRequestHostAvailability = ReadonlyMap<
  EnvironmentId,
  Pick<PullRequestHostRead, "hosts" | "projectHosts">
>;

export type PullRequestHostRead = {
  readonly observedAt: number;
  readonly resetAt?: number;
  readonly hosts: ReadonlyMap<
    string,
    { readonly configured: boolean; readonly observedAt: number }
  >;
  readonly projectHosts: ReadonlyMap<
    ProjectId,
    { readonly host: string; readonly observedAt: number }
  >;
};

export function resetPullRequestHosts(
  previous: ReadonlyMap<EnvironmentId, PullRequestHostRead>,
): ReadonlyMap<EnvironmentId, PullRequestHostRead> {
  return new Map(
    [...previous].map(([id, read]) => [
      id,
      { ...read, resetAt: read.observedAt, hosts: new Map(), projectHosts: new Map() },
    ]),
  );
}

export function rememberPullRequestHosts(
  previous: ReadonlyMap<EnvironmentId, PullRequestHostRead>,
  observations: ReadonlyArray<
    readonly [
      EnvironmentId,
      { readonly providers: ReadonlyArray<PullRequestProviderSummary> },
      number,
    ]
  >,
): ReadonlyMap<EnvironmentId, PullRequestHostRead> {
  const activeHosts = new Map<
    EnvironmentId,
    Map<string, { configured: boolean; observedAt: number }>
  >();
  for (const [environmentId, { providers }, observedAt] of observations) {
    if (observedAt <= (previous.get(environmentId)?.resetAt ?? -Infinity)) continue;
    let hosts = activeHosts.get(environmentId);
    if (hosts === undefined) {
      hosts = new Map();
      activeHosts.set(environmentId, hosts);
    }
    for (const provider of providers) {
      const host = provider.host.toLowerCase();
      const held = hosts.get(host);
      hosts.set(host, {
        configured: provider.configured || held?.configured === true,
        observedAt: Math.max(observedAt, held?.observedAt ?? -Infinity),
      });
    }
  }
  let next = previous;
  for (const [environmentId, { providers }, observedAt] of observations) {
    const before = next.get(environmentId);
    if (observedAt <= (before?.resetAt ?? -Infinity)) continue;
    const hosts = new Map(before?.hosts);
    const projectHosts = new Map(before?.projectHosts);
    let changed = false;
    let latestObservedAt = observedAt;
    for (const provider of providers) {
      const host = provider.host.toLowerCase();
      const active = activeHosts.get(environmentId)!.get(host)!;
      const held = hosts.get(host);
      if (
        active.observedAt > (held?.observedAt ?? -Infinity) ||
        (active.observedAt === held?.observedAt && active.configured && !held.configured)
      ) {
        hosts.set(host, active);
        latestObservedAt = Math.max(latestObservedAt, active.observedAt);
        changed = true;
      }
      for (const projectId of provider.projectIds ?? []) {
        if (observedAt > (projectHosts.get(projectId)?.observedAt ?? -Infinity)) {
          projectHosts.set(projectId, { host, observedAt });
          changed = true;
        }
      }
    }
    if (!changed) continue;
    next = new Map(next).set(environmentId, {
      ...before,
      observedAt: Math.max(before?.observedAt ?? -Infinity, latestObservedAt),
      hosts,
      projectHosts,
    });
  }
  return next;
}

function repositoryKey(project: AssignableProject): string | undefined {
  return project.repositoryIdentity?.canonicalKey?.toLowerCase();
}

export function assignProjectsToEnvironments(
  projects: ReadonlyArray<AssignableProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  preferredEnvironmentId?: EnvironmentId | null,
  hostAvailability?: PullRequestHostAvailability,
): Map<EnvironmentId, ProjectId[]> {
  const rank = new Map(environmentIds.map((id, index) => [id, index] as const));
  const owner = new Map<string, AssignableProject>();
  const unreadable = (project: AssignableProject) => {
    const availability = hostAvailability?.get(project.environmentId);
    const host =
      availability?.projectHosts.get(project.id)?.host ??
      pullRequestHostOf(
        project.repositoryIdentity,
        (project.repositoryIdentity?.provider ?? "unknown") as SourceControlProviderKind,
      );
    return availability?.hosts.get(host)?.configured === false;
  };
  for (const project of projects) {
    const key = repositoryKey(project);
    if (!key) continue;
    const environmentRank = rank.get(project.environmentId);
    if (environmentRank === undefined) continue;
    const current = owner.get(key);
    if (current === undefined) {
      owner.set(key, project);
      continue;
    }
    const currentUnreadable = unreadable(current);
    const candidateUnreadable = unreadable(project);
    if (currentUnreadable !== candidateUnreadable) {
      if (currentUnreadable) owner.set(key, project);
      continue;
    }
    if (current.environmentId === preferredEnvironmentId) continue;
    if (
      project.environmentId === preferredEnvironmentId ||
      environmentRank < (rank.get(current.environmentId) ?? Number.MAX_SAFE_INTEGER)
    ) {
      owner.set(key, project);
    }
  }
  const assignment = new Map<EnvironmentId, ProjectId[]>();
  for (const project of projects) {
    if (!rank.has(project.environmentId)) continue;
    const key = repositoryKey(project);
    if (key && owner.get(key)?.environmentId !== project.environmentId) continue;
    const listed = assignment.get(project.environmentId);
    if (listed === undefined) assignment.set(project.environmentId, [project.id]);
    else listed.push(project.id);
  }
  return assignment;
}

export function pullRequestProjectQueries(
  projects: ReadonlyArray<AssignableProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  hostAvailability?: PullRequestHostAvailability,
): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly projectIds?: ReadonlyArray<ProjectId>;
}> {
  const assignment = assignProjectsToEnvironments(
    projects,
    environmentIds,
    environmentIds[0],
    hostAvailability,
  );
  const totals = new Map<EnvironmentId, number>();
  for (const project of projects)
    totals.set(project.environmentId, (totals.get(project.environmentId) ?? 0) + 1);
  return environmentIds.flatMap((environmentId) => {
    const projectIds = assignment.get(environmentId);
    if (projectIds === undefined) return [];
    if (projectIds.length === totals.get(environmentId)) return [{ environmentId }];
    const queries: Array<{ environmentId: EnvironmentId; projectIds: ReadonlyArray<ProjectId> }> =
      [];
    for (let offset = 0; offset < projectIds.length; offset += PULL_REQUEST_LIST_PROJECT_LIMIT) {
      queries.push({
        environmentId,
        projectIds: projectIds.slice(offset, offset + PULL_REQUEST_LIST_PROJECT_LIMIT),
      });
    }
    return queries;
  });
}

export interface PickableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly label: string;
  readonly machine?: EnvironmentMachineKind;
}

export function resolvePickableEnvironments(
  current: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
  projects: ReadonlyArray<AssignableProject & { readonly workspaceRoot: string }>,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly machine?: EnvironmentMachineKind;
  }>,
): ReadonlyArray<PickableEnvironment> {
  const own = projects.find(
    (project) =>
      project.environmentId === current.environmentId && project.id === current.projectId,
  );
  const key = own === undefined ? undefined : repositoryKey(own);
  const ownEnvironment = environments.find(
    (environment) => environment.environmentId === current.environmentId,
  );
  if (own === undefined || !key || ownEnvironment === undefined) return [];
  const others = environments.flatMap((environment) => {
    if (environment.environmentId === current.environmentId) return [];
    const copy = projects.find(
      (project) =>
        project.environmentId === environment.environmentId && repositoryKey(project) === key,
    );
    return copy === undefined
      ? []
      : [
          {
            environmentId: environment.environmentId,
            projectId: copy.id,
            workspaceRoot: copy.workspaceRoot,
            label: environment.label,
            ...(environment.machine === undefined ? {} : { machine: environment.machine }),
          },
        ];
  });
  if (others.length === 0) return [];
  return [
    {
      environmentId: current.environmentId,
      projectId: own.id,
      workspaceRoot: own.workspaceRoot,
      label: ownEnvironment.label,
      ...(ownEnvironment.machine === undefined ? {} : { machine: ownEnvironment.machine }),
    },
    ...others,
  ];
}
