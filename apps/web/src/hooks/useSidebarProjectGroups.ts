import { orderItemsByPreferredIds, sortSidebarV2ProjectGroups } from "../components/Sidebar.logic";
import {
  getProjectOrderKey,
  resolveProjectIconSource,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import type { Project } from "../types";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import { useDelegatedUnderParent, useProjects, useQuietThreadShells } from "../state/entities";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

function useUnsortedSidebarProjectGroups() {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  return buildSidebarProjectSnapshots({
    projects: sortOrder === "manual" ? orderedProjects : projects,
    groupScratchProjects: true,
    settings: groupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
  });
}

export function useSidebarProjectGroups() {
  const unsortedGroups = useUnsortedSidebarProjectGroups();
  // Activity order lags a running thread's streaming ticks until its next
  // real change; reading every tick re-rendered the whole sidebar with it.
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const sortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  return sortSidebarV2ProjectGroups(unsortedGroups, threads, sortOrder, delegatedUnderParent);
}

/** The project whose icon stands for `project`: its own, else the one its sidebar group shows. */
export function useProjectIconSource(project: Project | null): Project | null {
  const groups = useUnsortedSidebarProjectGroups();
  if (!project) return null;
  const group = groups.find((candidate) =>
    candidate.memberProjectRefs.some(
      (ref) => ref.environmentId === project.environmentId && ref.projectId === project.id,
    ),
  );
  return resolveProjectIconSource<Project>(project, group);
}
