import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { Stack, useRouter } from "expo-router";
import { useMemo, useState } from "react";

import { useProjects, useThreadShells } from "../state/entities";
import { useWorkspaceState } from "../state/workspace";
import { buildThreadRoutePath } from "../lib/routes";
import { useSavedRemoteConnections } from "../state/use-remote-environment-registry";
import { HomeScreen } from "../features/home/HomeScreen";
import { HomeHeader } from "../features/home/HomeHeader";
import { useHomeListOptions } from "../features/home/home-list-options";
import { useThreadListActions } from "../features/home/useThreadListActions";
import { useAdaptiveWorkspaceLayout } from "../features/layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../features/layout/WorkspaceEmptyDetail";
import { WorkspaceSidebarToolbar } from "../features/layout/workspace-sidebar-toolbar";

/* ─── Route screen ───────────────────────────────────────────────────── */

export default function HomeRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
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
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const {
    options: listOptions,
    setSelectedEnvironmentId,
    setProjectGroupingMode,
    setProjectSortOrder,
    setThreadSortOrder,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;

  if (layout.usesSplitView) {
    return (
      <>
        <Stack.Screen
          options={{
            headerShown: true,
            headerTransparent: true,
            headerShadowVisible: false,
            headerTitle: "",
          }}
        />
        <WorkspaceSidebarToolbar />
        <WorkspaceEmptyDetail />
      </>
    );
  }

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
