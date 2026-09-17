import type { EnvironmentId } from "@t3tools/contracts";
import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import { toggleSettingsEnvironment } from "./settings-environment-filter.logic";

export type SettingsTarget = EnvironmentPresentation & {
  readonly serverConfig: NonNullable<EnvironmentPresentation["serverConfig"]>;
};

function connectedSettingsTargets(environments: readonly EnvironmentPresentation[]) {
  return environments.filter(
    (entry): entry is SettingsTarget =>
      entry.connection.phase === "connected" && entry.serverConfig !== null,
  );
}

const SettingsEnvironmentFilterContext = createContext<{
  readonly availableTargets: readonly SettingsTarget[];
  readonly selectedTargets: readonly SettingsTarget[];
  readonly selectedIds: ReadonlySet<EnvironmentId> | null;
  readonly projectGroups: ReturnType<typeof buildProjectGroups>;
  readonly selectableProjectGroups: ReturnType<typeof buildProjectGroups>;
  readonly selectedProjectKey: string | null;
  readonly selectProject: (projectKey: string | null) => void;
  readonly selectAll: () => void;
  readonly toggleEnvironment: (environmentId: EnvironmentId) => void;
} | null>(null);

export function SettingsEnvironmentFilterProvider(props: { readonly children: ReactNode }) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const groupingSettings = useMobileProjectGroupingSettings();
  const groupingMode = groupingSettings.sidebarProjectGroupingMode;
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectGroups = useMemo(
    () =>
      buildProjectGroups({
        projects,
        settings: { sidebarProjectGroupingMode: groupingMode, sidebarProjectGroupingOverrides: {} },
      }),
    [projects, groupingMode],
  );
  const availableTargets = useMemo(() => connectedSettingsTargets(environments), [environments]);
  const selectedTargets = useMemo(
    () =>
      availableTargets.filter(
        (entry) => selectedIds === null || selectedIds.has(entry.environmentId),
      ),
    [availableTargets, selectedIds],
  );
  const selectableProjectGroups = useMemo(
    () =>
      projectGroups.filter((group) =>
        group.members.some((member) =>
          selectedTargets.some((target) => target.environmentId === member.project.environmentId),
        ),
      ),
    [projectGroups, selectedTargets],
  );
  const value = useMemo(
    () => ({
      availableTargets,
      selectedTargets,
      selectedIds,
      projectGroups,
      selectableProjectGroups,
      selectedProjectKey,
      selectProject: setSelectedProjectKey,
      selectAll: () => setSelectedIds(null),
      toggleEnvironment: (environmentId: EnvironmentId) =>
        setSelectedIds((current) =>
          toggleSettingsEnvironment(current, availableTargets, environmentId),
        ),
    }),
    [
      availableTargets,
      selectedTargets,
      selectedIds,
      projectGroups,
      selectableProjectGroups,
      selectedProjectKey,
    ],
  );
  return (
    <SettingsEnvironmentFilterContext value={value}>
      {props.children}
    </SettingsEnvironmentFilterContext>
  );
}

export function useSettingsEnvironmentFilter() {
  const filter = useContext(SettingsEnvironmentFilterContext);
  if (filter === null) throw new Error("Settings environment filter provider is missing.");
  return filter;
}
