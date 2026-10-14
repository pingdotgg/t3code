import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { repositoryGroupingKeyOf, type EnvironmentId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" };

export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
): EnvironmentProject {
  return (
    scope.projects.find((project) => project.environmentId === preferredEnvironmentId) ??
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

function getOnlySelectableProject(
  projectScopes: ReadonlyArray<HomeProjectScope>,
): EnvironmentProject | null {
  const onlyScope = projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope?.representative ?? null;
}

export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // `|| null` (not `??`): a pending-task placeholder project can have an empty
  // workspaceRoot, and an "" basename would match nothing meaningful.
  const workspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  // The weaker signals only apply where identity is unknown on at least one
  // side; two known, different repositories never match on a shared basename
  // or title (mirrors the environment list filter in the new-task flow).
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

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  if (hasExplicitProjectSelection) {
    return { kind: "preserve" };
  }

  const onlyProject = getOnlySelectableProject(projectScopes);
  return onlyProject ? { kind: "select", project: onlyProject } : { kind: "pick" };
}

const NO_PROJECTS: ReadonlyArray<EnvironmentProject> = [];

/**
 * The selected project's copy on each machine of its logical group, the only
 * places auto balance may send a draft. Grouping settings decide what counts
 * as the same project, so a sibling path of the same repository is never one.
 */
export function resolveBalancedProjects(
  projectScopes: ReadonlyArray<HomeProjectScope>,
  selectedProject: EnvironmentProject | null,
): ReadonlyArray<EnvironmentProject> {
  if (selectedProject === null) return NO_PROJECTS;
  const isSelected = (project: EnvironmentProject) =>
    project.environmentId === selectedProject.environmentId && project.id === selectedProject.id;
  const scope = projectScopes.find((candidate) => candidate.projects.some(isSelected));
  if (!scope) return NO_PROJECTS;
  const byEnvironment = new Map<EnvironmentId, EnvironmentProject>();
  for (const project of scope.projects) {
    if (isSelected(project) || !byEnvironment.has(project.environmentId)) {
      byEnvironment.set(project.environmentId, project);
    }
  }
  return [...byEnvironment.values()];
}

export type AutoBalanceStatus = "checking" | "unavailable" | "balanced";

/**
 * Where an automatically routed draft stands, or null when its machine is the
 * user's own choice. Attachments keep a draft that has not been routed yet on
 * its current machine; one that already was stays automatic.
 */
export function resolveAutoBalanceStatus(input: {
  readonly canAutoBalance: boolean;
  readonly environmentPinned: boolean;
  readonly hasAttachments: boolean;
  readonly loadBalancedEnvironmentId: EnvironmentId | null;
  readonly pending: boolean;
}): AutoBalanceStatus | null {
  if (!input.canAutoBalance || input.environmentPinned) return null;
  if (input.loadBalancedEnvironmentId !== null) return "balanced";
  if (input.hasAttachments) return null;
  return input.pending ? "checking" : "unavailable";
}
