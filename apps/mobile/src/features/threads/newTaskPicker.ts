import type {
  EnvironmentProject,
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
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

export function deriveNewTaskProjectPickerEmptyState(input: {
  readonly environment: {
    readonly connectionState: EnvironmentConnectionPhase;
    readonly connectionError: string | null;
  } | null;
  readonly networkOffline: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly shellError: string | null;
  readonly hasShellSnapshot: boolean;
}): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
} {
  const connectionUnavailable =
    input.environment === null ||
    input.networkOffline ||
    input.environment.connectionState === "available" ||
    input.environment.connectionState === "offline" ||
    input.environment.connectionState === "error";

  if (connectionUnavailable && !input.hasShellSnapshot) {
    return {
      title: "Environment unavailable",
      detail:
        input.environment?.connectionError ??
        input.shellError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (input.shellError !== null && !input.hasShellSnapshot) {
    // The connection itself can stay healthy while the shell subscription
    // fails. Without this branch the picker spins on "Loading projects" and
    // never reports why no project ever arrives.
    return {
      title: "Could not load projects",
      detail: input.shellError,
      loading: false,
    };
  }

  if (!input.hasShellSnapshot) {
    return {
      title:
        input.shellStatus === "synchronizing" ? "Loading projects" : "Connecting to environment",
      detail: "Loading projects from the selected environment.",
      loading: true,
    };
  }

  return {
    title: "No projects found",
    detail: "The selected environment did not report any projects.",
    loading: false,
  };
}

export type NewTaskProjectPickerAction = "none" | "add-environment" | "add-project";

export function deriveNewTaskProjectPickerAction(input: {
  readonly hasSelectedEnvironment: boolean;
  readonly canAddProject: boolean;
  readonly loading: boolean;
}): NewTaskProjectPickerAction {
  if (input.loading) {
    return "none";
  }
  if (input.canAddProject) {
    return "add-project";
  }
  // Adding another connection is only useful when no environment was chosen.
  // Once one is selected the offer contradicts the screen the user is on, and
  // adding a project needs that environment to be reachable first.
  return input.hasSelectedEnvironment ? "none" : "add-environment";
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
        catalogState.shellSnapshotError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (catalogState.shellSnapshotError !== null && !catalogState.hasLoadedShellSnapshot) {
    return {
      title: "Could not load projects",
      detail: catalogState.shellSnapshotError,
      loading: false,
    };
  }

  if (
    !catalogState.hasLoadedShellSnapshot &&
    (catalogState.hasConnectingEnvironment ||
      catalogState.hasPendingShellSnapshot ||
      catalogState.hasReadyEnvironment)
  ) {
    return {
      title: catalogState.hasPendingShellSnapshot
        ? "Loading projects"
        : "Connecting to environment",
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
