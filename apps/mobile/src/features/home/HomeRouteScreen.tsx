import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");
  const { archiveThread, confirmDeleteThread } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
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

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView) {
    return (
      <>
        <NativeStackScreenOptions options={{ title: "", headerTitle: "" }} />
        <WorkspaceSidebarToolbar
          afterSidebarButton={
            <NativeHeaderToolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            />
          }
        />
        <WorkspaceEmptyDetail
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        />
      </>
    );
  }

  return (
    <>
      {/* Restore the compact title in case the split branch blanked it. */}
      <NativeStackScreenOptions options={{ title: "Threads", headerTitle: "Threads" }} />
      <HomeHeader
        environments={environments}
        selectedEnvironmentId={selectedEnvironmentId}
        projectSortOrder={listOptions.projectSortOrder}
        threadSortOrder={listOptions.threadSortOrder}
        projectGroupingMode={listOptions.projectGroupingMode}
        onEnvironmentChange={setSelectedEnvironmentId}
        onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
        onProjectGroupingModeChange={setProjectGroupingMode}
        onProjectSortOrderChange={setProjectSortOrder}
        onSearchQueryChange={setSearchQuery}
        onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        onThreadSortOrderChange={setThreadSortOrder}
      />

      <HomeScreen
        catalogState={catalogState}
        environments={environments}
        onAddConnection={() =>
          navigation.navigate("SettingsSheet", { screen: "SettingsEnvironmentNew" })
        }
        onArchiveThread={archiveThread}
        onDeleteThread={confirmDeleteThread}
        onEnvironmentChange={setSelectedEnvironmentId}
        onOpenEnvironments={() =>
          navigation.navigate("SettingsSheet", { screen: "SettingsEnvironments" })
        }
        onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
        onProjectGroupingModeChange={setProjectGroupingMode}
        onProjectSortOrderChange={setProjectSortOrder}
        onSearchQueryChange={setSearchQuery}
        onSelectThread={(thread) => {
          navigation.navigate("Thread", {
            environmentId: thread.environmentId,
            threadId: thread.id,
          });
        }}
        onSelectPendingTask={openPendingTask}
        onDeletePendingTask={confirmDeletePendingTask}
        onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        onThreadSortOrderChange={setThreadSortOrder}
        pendingTasks={pendingTasks}
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
