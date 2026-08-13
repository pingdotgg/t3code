import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

/** The little of a project this needs: who holds it, and which repository it is a copy of. */
export interface AssignableProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: { readonly canonicalKey?: string | undefined } | null | undefined;
}

/**
 * The remote's normalized URL is what says "same repository" across machines — it comes from the
 * remote, not from a local path. Empty where the project has no identity to compare with.
 *
 * `normalizeGitRemoteUrl` already lower-cases the whole remote, so the key arrives cased one way
 * whatever the remote said; the fold here only guards a key assembled some other way.
 */
function repositoryKey(project: AssignableProject): string | undefined {
  return project.repositoryIdentity?.canonicalKey?.toLowerCase();
}

/**
 * Two servers can hold the same repository, and both would list the same pull requests, so one
 * copy is picked by its repository key.
 *
 * A project with no identity is never de-duplicated: nothing proves it is a copy of anything, and
 * dropping it would lose its rows outright.
 */
export function assignProjectsToEnvironments(
  projects: ReadonlyArray<AssignableProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  preferredEnvironmentId?: EnvironmentId | null,
): Map<EnvironmentId, ProjectId[]> {
  const rank = new Map(environmentIds.map((id, index) => [id, index] as const));
  // Which server lists each repository: the preferred one where it has it, else the first.
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

/** A copy of the repository the reader could act on, named by the server holding it. */
export interface PickableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly label: string;
}

/**
 * Which servers a pull request could be acted on, given the one it is listed under.
 *
 * Listing picks a single server per repository so each pull request appears once; acting is a
 * different question. Checking the branch out, or handing it to a thread, happens wherever the
 * reader means to work — and the copy the listing happened not to pick is just as real.
 *
 * Empty where there is no choice to offer: one server, no repository identity to match copies by,
 * or projects not read yet. The caller renders nothing then, so a lone server keeps the surface it
 * has always had.
 */
export function resolvePickableEnvironments(
  current: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
  projects: ReadonlyArray<AssignableProject & { readonly workspaceRoot: string }>,
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
): ReadonlyArray<PickableEnvironment> {
  const own = projects.find(
    (project) =>
      project.environmentId === current.environmentId && project.id === current.projectId,
  );
  const key = own === undefined ? undefined : repositoryKey(own);
  const ownLabel = environments.find(
    (environment) => environment.environmentId === current.environmentId,
  )?.label;
  if (own === undefined || !key || ownLabel === undefined) return [];
  const others = environments.flatMap((environment) => {
    if (environment.environmentId === current.environmentId) return [];
    // One entry per server, whichever copy comes first: a server holding two worktrees of the
    // repository is still one place to act, and what is being picked here is the server.
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
          },
        ];
  });
  if (others.length === 0) return [];
  // The panel's own server first: it is what everything else on the panel is showing, so it is
  // also what acting means until the reader says otherwise.
  return [
    {
      environmentId: current.environmentId,
      projectId: own.id,
      workspaceRoot: own.workspaceRoot,
      label: ownLabel,
    },
    ...others,
  ];
}
