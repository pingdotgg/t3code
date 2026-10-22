import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

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
  settings: ProjectGroupingSettings = {
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  },
): EnvironmentProject | null {
  if (selectedProject === null) return projectsOnTarget[0] ?? null;
  const key = deriveLogicalProjectKeyFromSettings(selectedProject, settings);
  return (
    projectsOnTarget.find(
      (project) => deriveLogicalProjectKeyFromSettings(project, settings) === key,
    ) ?? null
  );
}

/** Keep a queued task's host available even before its project shell loads. */
export function resolveNewTaskEnvironments(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly selectedProject: EnvironmentProject | null;
  readonly settings: ProjectGroupingSettings;
  readonly savedConnectionsById: Readonly<
    Record<string, { readonly environmentLabel: string } | undefined>
  >;
  readonly pendingTaskEnvironmentId: EnvironmentId | null;
}): Array<{ readonly environmentId: EnvironmentId; readonly environmentLabel: string }> {
  const selectedKey = input.selectedProject
    ? deriveLogicalProjectKeyFromSettings(input.selectedProject, input.settings)
    : null;
  const candidates = input.projects
    .filter(
      (project) =>
        selectedKey === null ||
        deriveLogicalProjectKeyFromSettings(project, input.settings) === selectedKey,
    )
    .map((project) => project.environmentId);
  if (input.pendingTaskEnvironmentId !== null) {
    candidates.unshift(input.pendingTaskEnvironmentId);
  }
  return [...new Set(candidates)].flatMap((environmentId) => {
    const environment = input.savedConnectionsById[environmentId];
    return environment ? [{ environmentId, environmentLabel: environment.environmentLabel }] : [];
  });
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
  draft: {
    readonly incomingShareId: string | undefined;
    /** The draft's first project picker closed and the draft is showing again. */
    readonly pickerClosed: boolean;
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

  const onlyScope =
    draft.incomingShareId !== undefined && projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope ? { kind: "select", project: onlyScope.representative } : { kind: "pick" };
}

type ProjectRef = { readonly environmentId: string; readonly projectId: string };

export function newTaskDestination(options: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly requestId: string;
  readonly useLastProject: boolean | undefined;
  readonly currentProject: ProjectRef | undefined;
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
      : (find(options.currentProject) ?? (last?.archivedAt == null ? last : undefined));
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
