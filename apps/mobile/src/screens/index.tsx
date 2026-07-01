import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import {
  NativeHeaderToolbar,
  NativeStackScreenOptions,
  useAppNavigation,
} from "../navigation/native-stack-header";
import { useMemo, useState } from "react";

import { useProjects, useThreadShells } from "../state/entities";
import { useWorkspaceState } from "../state/workspace";
import {
  connectionsNewNavigation,
  newTaskNavigation,
  settingsEnvironmentsNavigation,
  settingsNavigation,
  threadNavigation,
} from "../lib/routes";
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
  const navigation = useAppNavigation();
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
        <NativeStackScreenOptions
          options={{
            headerShown: true,
            headerTransparent: true,
            headerShadowVisible: false,
            headerTitle: "",
          }}
        />
        <WorkspaceSidebarToolbar
          afterSidebarButton={
            <NativeHeaderToolbar.Button
              accessibilityLabel="Start new task"
              icon="square.and.pencil"
              onPress={() => navigation.push(newTaskNavigation())}
            />
          }
        />
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
        onOpenSettings={() => navigation.push(settingsNavigation())}
        onProjectGroupingModeChange={setProjectGroupingMode}
        onProjectSortOrderChange={setProjectSortOrder}
        onSearchQueryChange={setSearchQuery}
        onStartNewTask={() => navigation.push(newTaskNavigation())}
        onThreadSortOrderChange={setThreadSortOrder}
      />

      <HomeScreen
        catalogState={catalogState}
        environments={environments}
        onAddConnection={() => navigation.push(connectionsNewNavigation())}
        onArchiveThread={archiveThread}
        onDeleteThread={confirmDeleteThread}
        onEnvironmentChange={setSelectedEnvironmentId}
        onOpenEnvironments={() => navigation.push(settingsEnvironmentsNavigation())}
        onOpenSettings={() => navigation.push(settingsNavigation())}
        onProjectGroupingModeChange={setProjectGroupingMode}
        onProjectSortOrderChange={setProjectSortOrder}
        onSearchQueryChange={setSearchQuery}
        onSelectThread={(thread) => {
          navigation.push(threadNavigation(thread));
        }}
        onStartNewTask={() => navigation.push(newTaskNavigation())}
        onThreadSortOrderChange={setThreadSortOrder}
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
