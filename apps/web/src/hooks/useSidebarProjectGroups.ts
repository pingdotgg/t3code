import { useMessages } from "gt-react";

import { sortSidebarV2ProjectGroups } from "../components/Sidebar.logic";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import { useDelegatedUnderParent, useProjects, useQuietThreadShells } from "../state/entities";
import { orderProjectsManually, useProjectOrder } from "../projectOrder";
import { useClientSettings } from "./useSettings";

export function useSidebarProjectGroups() {
  const projects = useProjects();
  // Activity order lags a running thread's streaming ticks until its next
  // real change; reading every tick re-rendered the whole sidebar with it.
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projectOrder = useProjectOrder();
  const sortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const resolve = useMessages();
  const orderedProjects = orderProjectsManually(projects, projectOrder);
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const unsortedGroups = buildSidebarProjectSnapshots(
    {
      projects: sortOrder === "manual" ? orderedProjects : projects,
      groupScratchProjects: true,
      settings: groupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
    },
    resolve,
  );
  return sortSidebarV2ProjectGroups(unsortedGroups, threads, sortOrder, delegatedUnderParent);
}
