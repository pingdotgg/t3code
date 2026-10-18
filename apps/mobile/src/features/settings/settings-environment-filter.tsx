import type { EnvironmentId } from "@t3tools/contracts";
import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

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

interface SettingsScope {
  readonly selectedIds: ReadonlySet<EnvironmentId> | null;
  readonly selectedProjectKey: string | null;
}

const ALL_SETTINGS: SettingsScope = { selectedIds: null, selectedProjectKey: null };

const SettingsScopeContext = createContext<
  readonly [SettingsScope, Dispatch<SetStateAction<SettingsScope>>] | null
>(null);
const SettingsSidebarContext = createContext(false);

/**
 * iPad and the unfolded Duo show settings sections in the sidebar beside the
 * section content, and a fold moves them into a sheet. Each of those mounts its
 * own pages, so open settings keeps one scope here.
 */
export function SettingsScopeProvider(props: {
  readonly open: boolean;
  readonly sidebar: boolean;
  readonly children: ReactNode;
}) {
  const [scope, setScope] = useState(ALL_SETTINGS);
  const [open, setOpen] = useState(props.open);
  if (open !== props.open) {
    setOpen(props.open);
    setScope(ALL_SETTINGS);
  }
  const value = useMemo(() => [scope, setScope] as const, [scope]);
  return (
    <SettingsScopeContext value={value}>
      <SettingsSidebarContext value={props.sidebar}>{props.children}</SettingsSidebarContext>
    </SettingsScopeContext>
  );
}

export function useSettingsSidebarActive() {
  return useContext(SettingsSidebarContext);
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
  const sharedScope = useContext(SettingsScopeContext);
  const ownScope = useState(ALL_SETTINGS);
  const [{ selectedIds, selectedProjectKey }, setScope] = sharedScope ?? ownScope;
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
      selectProject: (projectKey: string | null) =>
        setScope((current) => ({ ...current, selectedProjectKey: projectKey })),
      selectAll: () => setScope((current) => ({ ...current, selectedIds: null })),
      toggleEnvironment: (environmentId: EnvironmentId) =>
        setScope((current) => ({
          ...current,
          selectedIds: toggleSettingsEnvironment(
            current.selectedIds,
            availableTargets,
            environmentId,
          ),
        })),
    }),
    [
      availableTargets,
      selectedTargets,
      selectedIds,
      projectGroups,
      selectableProjectGroups,
      selectedProjectKey,
      setScope,
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
