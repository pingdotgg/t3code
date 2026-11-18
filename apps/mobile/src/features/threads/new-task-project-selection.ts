import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { repositoryGroupingKeyOf, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" }
  | { readonly kind: "dismiss" };

/**
 * The copy of a project a new thread starts in: the preferred environment's, then the
 * representative. A connected copy wins over a disconnected one.
 */
export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): EnvironmentProject {
  const rank = (project: EnvironmentProject) =>
    project.environmentId === preferredEnvironmentId ? 0 : project === scope.representative ? 1 : 2;
  const ordered = [...scope.projects].sort((left, right) => rank(left) - rank(right));
  return (
    ordered.find((project) => connectedEnvironmentIds.has(project.environmentId)) ??
    ordered[0] ??
    scope.representative
  );
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

export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // Use || null: placeholder workspaceRoot can be empty, which supplies no useful basename.
  const workspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
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
            project.workspaceRoot.split("/").at(-1) === workspaceBasename,
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

type ProjectRef = { readonly environmentId: string; readonly projectId: string };

const isProjectRef = (project: EnvironmentProject, ref: ProjectRef | undefined) =>
  project.environmentId === ref?.environmentId && project.id === ref.projectId;

/**
 * The copy of the thread list's filtered project a new thread starts in: the current thread's
 * if it is a copy, else the remembered live one, else a live one on a connected machine.
 */
export function newTaskFilteredProject(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
  currentProject: ProjectRef | undefined,
  lastProject: ProjectRef | undefined,
): ProjectRef | undefined {
  if (scope.projects.some((project) => isProjectRef(project, currentProject))) {
    return currentProject;
  }
  const live = scope.projects.filter((project) => project.archivedAt == null);
  if (live.length === 0) return undefined;
  const project =
    live.find((candidate) => isProjectRef(candidate, lastProject)) ??
    getProjectScopeSelectionTarget(
      { ...scope, projects: live },
      preferredEnvironmentId,
      connectedEnvironmentIds,
    );
  return { environmentId: project.environmentId, projectId: project.id };
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
  // The list filter is the user's explicit choice, so a current thread outside it doesn't win.
  // A remembered project that was archived since opens the picker; the current one still wins.
  const last = find(options.lastProject);
  const project =
    options.useLastProject === false
      ? undefined
      : (find(options.filteredProject) ??
        find(options.currentProject) ??
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
