import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import {
  DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE,
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";

import { useProjects, useThreadShells } from "../state/entities";
import { useWorkspaceState } from "../state/workspace";
import { buildThreadRoutePath } from "../lib/routes";
import { useSavedRemoteConnections } from "../state/use-remote-environment-registry";
import { HomeScreen } from "../features/home/HomeScreen";
import { HomeHeader } from "../features/home/HomeHeader";
import type { HomeProjectSortOrder } from "../features/home/homeThreadList";
import { useThreadListActions } from "../features/home/useThreadListActions";

interface HomeListOptions {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

/* ─── Route screen ───────────────────────────────────────────────────── */

export default function HomeRouteScreen() {
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [listOptions, setListOptions] = useState<HomeListOptions>({
    selectedEnvironmentId: null,
    projectSortOrder:
      DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
        ? "updated_at"
        : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
    threadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
    projectGroupingMode: DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE,
  });
  const { archiveThread, confirmDeleteThread } = useThreadListActions();
  const environments = useMemo(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        })),
        Order.mapInput(
          Order.String,
          (environment: { readonly label: string }) => environment.label,
        ),
      ),
    [savedConnectionsById],
  );
  const selectedEnvironmentId = environments.some(
    (environment) => environment.environmentId === listOptions.selectedEnvironmentId,
  )
    ? listOptions.selectedEnvironmentId
    : null;
  const setSelectedEnvironmentId = useCallback((environmentId: EnvironmentId | null) => {
    setListOptions((current) => ({ ...current, selectedEnvironmentId: environmentId }));
  }, []);
  const setProjectSortOrder = useCallback((projectSortOrder: HomeProjectSortOrder) => {
    setListOptions((current) => ({ ...current, projectSortOrder }));
  }, []);
  const setThreadSortOrder = useCallback((threadSortOrder: SidebarThreadSortOrder) => {
    setListOptions((current) => ({ ...current, threadSortOrder }));
  }, []);
  const setProjectGroupingMode = useCallback((projectGroupingMode: SidebarProjectGroupingMode) => {
    setListOptions((current) => ({ ...current, projectGroupingMode }));
  }, []);

  return (
    <>
      <HomeHeader
        environments={environments}
        selectedEnvironmentId={selectedEnvironmentId}
        projectSortOrder={listOptions.projectSortOrder}
        threadSortOrder={listOptions.threadSortOrder}
        projectGroupingMode={listOptions.projectGroupingMode}
        onEnvironmentChange={setSelectedEnvironmentId}
        onOpenSettings={() => router.push("/settings")}
        onProjectGroupingModeChange={setProjectGroupingMode}
        onProjectSortOrderChange={setProjectSortOrder}
        onSearchQueryChange={setSearchQuery}
        onStartNewTask={() => router.push("/new")}
        onThreadSortOrderChange={setThreadSortOrder}
      />

      <HomeScreen
        catalogState={catalogState}
        onAddConnection={() => router.push("/connections/new")}
        onArchiveThread={archiveThread}
        onDeleteThread={confirmDeleteThread}
        onOpenEnvironments={() => router.push("/settings/environments")}
        onSelectThread={(thread) => {
          router.push(buildThreadRoutePath(thread));
        }}
        projectGroupingMode={listOptions.projectGroupingMode}
        projects={projects}
        projectSortOrder={listOptions.projectSortOrder}
        savedConnectionsById={savedConnectionsById}
        searchQuery={searchQuery}
        selectedEnvironmentId={selectedEnvironmentId}
        threads={threads}
        threadSortOrder={listOptions.threadSortOrder}
      />
    </>
  );
}
