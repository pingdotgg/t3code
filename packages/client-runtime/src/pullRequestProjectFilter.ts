import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

export interface PullRequestProjectFilterGroup {
  readonly label: string;
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
}

interface FilterProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
}

export function pullRequestFilterProjects<Project extends FilterProject>(
  projects: ReadonlyArray<Project>,
  groups: ReadonlyArray<PullRequestProjectFilterGroup>,
  selectedProject?: Pick<FilterProject, "id" | "environmentId">,
) {
  const keyOf = (environmentId: EnvironmentId, projectId: ProjectId) =>
    JSON.stringify([environmentId, projectId]);
  const byRef = new Map(
    projects.map((project) => [keyOf(project.environmentId, project.id), project]),
  );
  return groups.flatMap((group) => {
    const members = group.memberProjectRefs.flatMap((ref) => {
      const project = byRef.get(keyOf(ref.environmentId, ref.projectId));
      return project ? [project] : [];
    });
    const representative =
      members.find(
        (project) =>
          project.id === selectedProject?.id &&
          project.environmentId === selectedProject.environmentId,
      ) ?? members[0];
    return representative
      ? [
          {
            ...representative,
            title: group.label,
            memberProjectRefs: members.map((project) => ({
              environmentId: project.environmentId,
              projectId: project.id,
            })),
          },
        ]
      : [];
  });
}

export function pullRequestProjectFilterQueries(
  projects: ReadonlyArray<
    Pick<FilterProject, "id" | "environmentId"> & {
      readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
    }
  >,
  environmentIds: ReadonlyArray<EnvironmentId>,
  selectedProject?: { readonly id: string; readonly environmentId?: string | undefined },
): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly projectIds?: ReadonlyArray<ProjectId>;
}> {
  if (selectedProject === undefined)
    return environmentIds.map((environmentId) => ({ environmentId }));
  const selected = projects.find((project) =>
    project.memberProjectRefs.some(
      (ref) =>
        ref.projectId === selectedProject.id &&
        (selectedProject.environmentId === undefined ||
          ref.environmentId === selectedProject.environmentId),
    ),
  );
  return environmentIds.flatMap((environmentId) => {
    const projectIds =
      selected?.memberProjectRefs
        .filter((ref) => ref.environmentId === environmentId)
        .map((ref) => ref.projectId) ?? [];
    return projectIds.length > 0 ? [{ environmentId, projectIds }] : [];
  });
}
