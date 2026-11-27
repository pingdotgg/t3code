import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isPickableProjectMember,
  isRepositoryRootProject,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { repositoryGroupingKeyOf, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type ProjectRef = { readonly environmentId: string; readonly projectId: string };

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" }
  | { readonly kind: "dismiss" };

function selectOpenProjectScopeMember(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
  lastProject?: ProjectRef,
): EnvironmentProject | undefined {
  const open = scope.projects.filter(isPickableProjectMember);
  const remembered =
    lastProject &&
    open.find(
      (project) =>
        project.environmentId === lastProject.environmentId && project.id === lastProject.projectId,
    );
  if (remembered) return remembered;

  const rank = (project: EnvironmentProject) =>
    project.environmentId === preferredEnvironmentId ? 0 : project === scope.representative ? 1 : 2;
  open.sort(
    (left, right) =>
      rank(left) - rank(right) ||
      Number(isRepositoryRootProject(right)) - Number(isRepositoryRootProject(left)),
  );
  return open.find((project) => connectedEnvironmentIds.has(project.environmentId)) ?? open[0];
}

/**
 * Picker scopes have an open copy; prefer a connected one, then the selected environment, with a
 * repository root ahead of a sub-folder.
 */
export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): EnvironmentProject {
  const project = selectOpenProjectScopeMember(
    scope,
    preferredEnvironmentId,
    connectedEnvironmentIds,
  );
  if (!project) throw new Error("A pickable project group must have an open workspace");
  return project;
}

export function filterProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  searchText: string,
): ReadonlyArray<HomeProjectScope> {
  const query = searchText.trim().toLowerCase();
  if (!query) return scopes;
  return scopes.filter(
    (scope) =>
      scope.title.toLowerCase().includes(query) ||
      scope.projects.some(
        (project) =>
          project.title.toLowerCase().includes(query) ||
          project.workspaceRoot.toLowerCase().includes(query),
      ),
  );
}

// Cached configuration reserves the row; connection readiness only gates activation.
export function resolveNewTaskScratchOption(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  }>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "scratchWorkspaceRoot">>;
  readonly selectedEnvironmentId: EnvironmentId | null;
}) {
  const offering = input.environments.filter(
    (environment) =>
      (input.serverConfigs.get(environment.environmentId)?.scratchWorkspaceRoot ?? null) !== null,
  );
  const ready = offering.filter(
    (environment) =>
      availableScratchWorkspaceRoot(
        environment.connectionState,
        input.serverConfigs.get(environment.environmentId),
      ) !== null,
  );
  const candidates = ready.length > 0 ? ready : offering;
  const environment =
    candidates.find((candidate) => candidate.environmentId === input.selectedEnvironmentId) ??
    candidates[0];
  return environment ? { environmentId: environment.environmentId, ready: ready.length > 0 } : null;
}

/** A workspace root's folder name on any host OS. Empty placeholder roots and drive roots have none. */
export function workspaceFolderName(workspaceRoot: string): string | null {
  return /^(?:[a-zA-Z]:)?[/\\]*$/.test(workspaceRoot) ? null : fileBasename(workspaceRoot);
}

export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  const workspaceBasename = selectedProject
    ? workspaceFolderName(selectedProject.workspaceRoot)
    : null;
  // Use weaker signals only when identity is unknown; different known repositories never match by basename or title.
  const isKnownMismatch = (project: EnvironmentProject) => {
    const projectKey = project.repositoryIdentity
      ? repositoryGroupingKeyOf(project.repositoryIdentity)
      : null;
    return repositoryKey !== null && projectKey !== null && projectKey !== repositoryKey;
  };
  return (
    (repositoryKey !== null
      ? projectsOnTarget.find(
          (project) =>
            (project.repositoryIdentity
              ? repositoryGroupingKeyOf(project.repositoryIdentity)
              : null) === repositoryKey,
        )
      : undefined) ??
    (workspaceBasename !== null
      ? projectsOnTarget.find(
          (project) =>
            !isKnownMismatch(project) &&
            workspaceFolderName(project.workspaceRoot) === workspaceBasename,
        )
      : undefined) ??
    (selectedProject !== null
      ? projectsOnTarget.find(
          (project) => !isKnownMismatch(project) && project.title === selectedProject.title,
        )
      : undefined) ??
    projectsOnTarget[0] ??
    null
  );
}

/** Both projects have a known repository identity, and it is the same one. */
export function isSameRepository(
  left: EnvironmentProject | null,
  right: EnvironmentProject | null,
): boolean {
  return (
    left?.repositoryIdentity != null &&
    right?.repositoryIdentity != null &&
    repositoryGroupingKeyOf(left.repositoryIdentity) ===
      repositoryGroupingKeyOf(right.repositoryIdentity)
  );
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
  draft: {
    readonly incomingShareId: string | undefined;
    /** The draft's first project picker closed and the draft is showing again. */
    readonly pickerClosed: boolean;
    readonly useLastProject?: boolean | undefined;
    readonly lastProject?: ProjectRef | undefined;
  },
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  if (hasExplicitProjectSelection) {
    return { kind: "preserve" };
  }
  // A share draft holds content the user sent here, so cancelling the picker must not drop it.
  if (draft.pickerClosed && selectedProjectKey === null && draft.incomingShareId === undefined) {
    return { kind: "dismiss" };
  }

  if (draft.incomingShareId === undefined) {
    return { kind: "pick" };
  }
  const last =
    draft.useLastProject === false
      ? undefined
      : projects.find(
          (project) =>
            project.environmentId === draft.lastProject?.environmentId &&
            project.id === draft.lastProject.projectId &&
            project.archivedAt == null,
        );
  if (last) {
    return { kind: "select", project: last };
  }
  const onlyScope = projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope ? { kind: "select", project: onlyScope.representative } : { kind: "pick" };
}

/** The live copy of the thread list's filtered project a new thread starts in: the remembered one if it is a copy. */
export function newTaskFilteredProject(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
  lastProject: ProjectRef | undefined,
): ProjectRef | undefined {
  const project = selectOpenProjectScopeMember(
    scope,
    preferredEnvironmentId,
    connectedEnvironmentIds,
    lastProject,
  );
  return project && { environmentId: project.environmentId, projectId: project.id };
}

export function newTaskDestination(options: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly requestId: string;
  readonly useLastProject: boolean | undefined;
  readonly currentProject: ProjectRef | undefined;
  readonly filteredProject: ProjectRef | undefined;
  readonly lastProject: ProjectRef | undefined;
}) {
  const find = (ref: ProjectRef | undefined) =>
    ref &&
    options.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    );
  // A remembered project that was archived since opens the picker; the current one still wins.
  const last = find(options.lastProject);
  const project =
    options.useLastProject === false
      ? undefined
      : (find(options.currentProject) ??
        find(options.filteredProject) ??
        (last?.archivedAt == null ? last : undefined));
  return project
    ? {
        draft: {
          requestId: options.requestId,
          environmentId: String(project.environmentId),
          projectId: String(project.id),
        },
      }
    : { draft: { requestId: options.requestId } };
}
