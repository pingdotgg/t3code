import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "react-native";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import {
  buildProviderDriverMap,
  isHermesProviderInstance,
  isMobileWorkspaceThread,
  resolveHermesConversationTarget,
} from "../../lib/mobileWorkspace";
import { useMobileWorkspace } from "../../state/preferences";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { buildHomeProjectScopes } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const [workspace, setWorkspace] = useMobileWorkspace();
  const providerDrivers = useMemo(() => buildProviderDriverMap(serverConfigs), [serverConfigs]);
  const visibleThreads = useMemo(
    () => threads.filter((thread) => isMobileWorkspaceThread(thread, workspace, providerDrivers)),
    [providerDrivers, threads, workspace],
  );
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");
  const { archiveThread, confirmDeleteThread, settleThread, unsettleThread } =
    useThreadListActions();
  const allPendingTasks = usePendingNewTasks();
  const pendingTasks = useMemo(
    () =>
      workspace === "code"
        ? allPendingTasks
        : allPendingTasks.filter(
            (task) =>
              task.message.modelSelection !== undefined &&
              isHermesProviderInstance(
                task.message.environmentId,
                task.message.modelSelection.instanceId,
                providerDrivers,
              ),
          ),
    [allPendingTasks, providerDrivers, workspace],
  );
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
    setProjectSortOrder,
    setThreadSortOrder,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectFilterOptions = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: selectedEnvironmentId,
        projectGroupingMode: listOptions.projectGroupingMode,
      }).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentId],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);
  const startNewTask = () => {
    if (workspace === "code") {
      navigation.navigate("NewTaskSheet", { screen: "NewTask" });
      return;
    }
    const target = resolveHermesConversationTarget({
      projects,
      serverConfigs,
      requiredEnvironmentId: selectedEnvironmentId,
    });
    if (!target) {
      Alert.alert(
        "Hermes is not ready",
        "Enable and configure Hermes on a connected environment before starting a Work conversation.",
      );
      return;
    }
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: String(target.project.environmentId),
        projectId: String(target.project.id),
        title: "Hermes",
        workspace: "work",
        providerInstanceId: String(target.modelSelection.instanceId),
        model: target.modelSelection.model,
      },
    });
  };

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
              onPress={startNewTask}
            />
          }
        />
        <WorkspaceEmptyDetail onStartNewTask={startNewTask} />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout onStartNewTask={startNewTask}>
      <>
        {/* Restore the compact title in case the split branch blanked it. */}
        <NativeStackScreenOptions options={{ title: "Threads", headerTitle: "Threads" }} />
        <HomeHeader
          environments={environments}
          workspace={workspace}
          projects={workspace === "work" ? [] : projectFilterOptions}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={workspace === "work" ? null : selectedProjectKey}
          projectSortOrder={listOptions.projectSortOrder}
          threadSortOrder={listOptions.threadSortOrder}
          onEnvironmentChange={setSelectedEnvironmentId}
          onWorkspaceChange={setWorkspace}
          onProjectChange={setSelectedProjectKey}
          onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
          onProjectSortOrderChange={setProjectSortOrder}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={startNewTask}
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
          onSettleThread={settleThread}
          onUnsettleThread={unsettleThread}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", { screen: "SettingsEnvironments" })
          }
          onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
          onProjectSortOrderChange={setProjectSortOrder}
          onSearchQueryChange={setSearchQuery}
          onSelectThread={(thread) => {
            // Settled threads are live shells: opening one is plain
            // navigation, and sending a message un-settles server-side.
            navigation.navigate("Thread", {
              environmentId: thread.environmentId,
              threadId: thread.id,
            });
          }}
          onSelectPendingTask={openPendingTask}
          onDeletePendingTask={confirmDeletePendingTask}
          onNewThreadInProject={(project) => {
            navigation.navigate("NewTaskSheet", {
              screen: "NewTaskDraft",
              params: {
                environmentId: String(project.environmentId),
                projectId: String(project.id),
                title: project.title,
              },
            });
          }}
          onStartNewTask={startNewTask}
          onThreadSortOrderChange={setThreadSortOrder}
          pendingTasks={pendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={projects}
          projectSortOrder={listOptions.projectSortOrder}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={workspace === "work" ? null : selectedProjectKey}
          threads={visibleThreads}
          workspace={workspace}
          threadSortOrder={listOptions.threadSortOrder}
        />
      </>
    </AndroidHomeFabLayout>
  );
}
