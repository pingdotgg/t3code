import {
  type ClientSettings,
  type EnvironmentId,
  type ProjectId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useClientSettings } from "../hooks/useSettings";
import { getProjectOrderKey } from "../logicalProject";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "./Sidebar.logic";

// Each helper reads its own source hook so the compiler caches the derived value on that
// source. Taking the source as an argument instead leaves the helper hook-free, and the
// compiler then treats it as a plain function and caches nothing.
export function useEnvironmentLookups() {
  const { environments } = useEnvironments();
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectEnvironmentLocationById = new Map(
    environments.map((environment) => {
      const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
      const isLocal = isPrimary || isDesktopLocalConnectionTarget(environment.entry.target);
      return [
        environment.environmentId,
        {
          kind: isLocal ? "local" : "remote",
          label: isPrimary ? "Local" : isLocal ? `${environment.label} (Local)` : environment.label,
          machine: resolveEnvironmentMachineKind(environment.serverConfig),
        },
      ] as const;
    }),
  );
  return { environmentLabelById, projectEnvironmentLocationById };
}

export function useProjectLookups() {
  const projects = useProjects();
  const projectCwdById = new Map<ProjectId, string>(
    projects.map((project) => [project.id, project.workspaceRoot]),
  );
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const projectTitleById = new Map<ProjectId, string>(
    projects.map((project) => [project.id, project.title]),
  );
  return { projectCwdById, projectByKey, projectTitleById };
}

export const selectCommandPaletteClientSettings = (settings: ClientSettings) => ({
  sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
  sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  sidebarProjectSortOrder: settings.sidebarProjectSortOrder,
  sidebarThreadSortOrder: settings.sidebarThreadSortOrder,
});

export function useSortedProjectGroups(environmentLabelById: ReadonlyMap<EnvironmentId, string>) {
  const projects = useProjects();
  const threads = useThreadShells();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const clientSettings = useClientSettings(selectCommandPaletteClientSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = {
    sidebarProjectGroupingMode: clientSettings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: clientSettings.sidebarProjectGroupingOverrides,
  };
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const unsortedProjectGroups = buildSidebarProjectSnapshots({
    projects: clientSettings.sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
  });
  return sortLogicalProjectsForSidebar(
    unsortedProjectGroups,
    threads,
    clientSettings.sidebarProjectSortOrder,
  );
}
