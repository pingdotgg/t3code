import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import type { WorkspaceState } from "../../state/workspaceModel";

export interface NewTaskPickerEnvironment {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

export interface NewTaskEnvironmentItem extends NewTaskPickerEnvironment {
  readonly projectCount: number;
}

export interface NewTaskProjectItem {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly key: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export function deriveNewTaskPickerEmptyState(catalogState: WorkspaceState): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
} {
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment before creating a task.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects from the saved environment.",
      loading: true,
    };
  }

  return {
    title: "No projects found",
    detail: "The connected environment did not report any projects.",
    loading: false,
  };
}

export function buildNewTaskProjectItems(input: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}): ReadonlyArray<NewTaskProjectItem> {
  const environmentProjects = input.projects.filter(
    (project) => project.environmentId === input.environmentId,
  );
  const environmentThreads = input.threads.filter(
    (thread) => thread.environmentId === input.environmentId,
  );

  return groupProjectsByRepository({
    projects: environmentProjects,
    threads: environmentThreads,
  }).flatMap((group): ReadonlyArray<NewTaskProjectItem> => {
    const project = group.projects[0]?.project;
    return project
      ? [
          {
            environmentId: project.environmentId,
            id: project.id,
            key: group.key,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          },
        ]
      : [];
  });
}

export function buildNewTaskEnvironmentItems(input: {
  readonly environments: ReadonlyArray<NewTaskPickerEnvironment>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}): ReadonlyArray<NewTaskEnvironmentItem> {
  return input.environments.flatMap((environment): ReadonlyArray<NewTaskEnvironmentItem> => {
    const projectCount = buildNewTaskProjectItems({
      environmentId: environment.environmentId,
      projects: input.projects,
      threads: input.threads,
    }).length;
    return projectCount > 0 ? [{ ...environment, projectCount }] : [];
  });
}
