import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

import { derivePhysicalProjectKey, type ProjectGroupingSettings } from "./logicalProject";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";

export interface ArchivedProjectGroup {
  readonly logicalProjectKey: string;
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

export interface ArchivedProjectModel {
  readonly archivedGroups: ReadonlyArray<ArchivedProjectGroup>;
  readonly projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
}

export interface ArchivedThreadsSearch {
  readonly project?: string;
}

export function validateArchivedThreadsSearch(raw: Record<string, unknown>): ArchivedThreadsSearch {
  return typeof raw.project === "string" && raw.project ? { project: raw.project } : {};
}

function scopedProjectId(project: Pick<EnvironmentProject, "environmentId" | "id">): string {
  return `${project.environmentId}:${project.id}`;
}

export function buildArchivedProjectModel(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly settings: ProjectGroupingSettings;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}): ArchivedProjectModel {
  const threadsByProject = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of input.threads) {
    const key = `${thread.environmentId}:${thread.projectId}`;
    const existing = threadsByProject.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProject.set(key, [thread]);
    }
  }

  const physicalGroups = input.projects.flatMap((project) => {
    const projectThreads = threadsByProject.get(scopedProjectId(project));
    if (!projectThreads?.length) return [];
    return [
      {
        project,
        threads: projectThreads.toSorted((left, right) => {
          const leftKey = left.archivedAt ?? left.createdAt;
          const rightKey = right.archivedAt ?? right.createdAt;
          return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
        }),
      },
    ];
  });
  const archivedProjects = physicalGroups.map((group) => group.project);
  const logicalKeyByPhysicalKey = buildPhysicalToLogicalProjectKeyMap({
    projects: archivedProjects,
    settings: input.settings,
    primaryEnvironmentId: input.primaryEnvironmentId,
  });
  const projectGroups = buildSidebarProjectSnapshots({
    projects: archivedProjects,
    settings: input.settings,
    primaryEnvironmentId: input.primaryEnvironmentId,
    resolveEnvironmentLabel: input.resolveEnvironmentLabel,
  }).sort((left, right) => left.displayName.localeCompare(right.displayName));

  return {
    projectGroups,
    archivedGroups: physicalGroups.map((group) => ({
      ...group,
      logicalProjectKey:
        logicalKeyByPhysicalKey.get(derivePhysicalProjectKey(group.project)) ??
        derivePhysicalProjectKey(group.project),
    })),
  };
}

export function filterArchivedProjectGroups(
  archivedGroups: ReadonlyArray<ArchivedProjectGroup>,
  projectKey: string | null,
  scopeReady: boolean,
): ReadonlyArray<ArchivedProjectGroup> {
  if (projectKey === null) return archivedGroups;
  if (!scopeReady) return [];
  return archivedGroups.filter((group) => group.logicalProjectKey === projectKey);
}
