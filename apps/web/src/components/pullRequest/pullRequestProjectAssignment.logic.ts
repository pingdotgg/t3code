import type { EnvironmentId, EnvironmentMachineKind, ProjectId } from "@t3tools/contracts";

export interface AssignableProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: { readonly canonicalKey?: string | undefined } | null | undefined;
}

function repositoryKey(project: AssignableProject): string | undefined {
  return project.repositoryIdentity?.canonicalKey?.toLowerCase();
}

export function assignProjectsToEnvironments(
  projects: ReadonlyArray<AssignableProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  preferredEnvironmentId?: EnvironmentId | null,
): Map<EnvironmentId, ProjectId[]> {
  const rank = new Map(environmentIds.map((id, index) => [id, index] as const));
  const owner = new Map<string, EnvironmentId>();
  for (const project of projects) {
    const key = repositoryKey(project);
    if (!key) continue;
    const environmentRank = rank.get(project.environmentId);
    if (environmentRank === undefined) continue;
    const current = owner.get(key);
    if (current === undefined) {
      owner.set(key, project.environmentId);
      continue;
    }
    if (current === preferredEnvironmentId) continue;
    if (
      project.environmentId === preferredEnvironmentId ||
      environmentRank < (rank.get(current) ?? Number.MAX_SAFE_INTEGER)
    ) {
      owner.set(key, project.environmentId);
    }
  }
  const assignment = new Map<EnvironmentId, ProjectId[]>();
  for (const project of projects) {
    if (!rank.has(project.environmentId)) continue;
    const key = repositoryKey(project);
    if (key && owner.get(key) !== project.environmentId) continue;
    const listed = assignment.get(project.environmentId);
    if (listed === undefined) assignment.set(project.environmentId, [project.id]);
    else listed.push(project.id);
  }
  return assignment;
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
