import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { Alert, Platform } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useClerkSettingsSheetDetent } from "../cloud/ClerkSettingsSheetDetent";
import { useArchivedThreadListActions } from "../home/useThreadListActions";
import {
  ArchivedThreadsScreen,
  type ArchivedThreadsHeaderEnvironment,
} from "./ArchivedThreadsScreen";
import {
  archivedThreadActionExceptionDescription,
  buildArchivedThreadGroups,
  parseArchivedThreadSearchInput,
  runArchivedThreadActions,
  type ArchivedThreadSortState,
} from "./archivedThreadList";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "./useArchivedThreadSnapshots";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopedThreadKey } from "../../lib/scopedEntities";

function confirmArchivedProjectAction(input: {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    if (Platform.OS === "ios") {
      Alert.alert(input.title, input.message, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: input.confirmText,
          style: input.destructive ? "destructive" : "default",
          onPress: () => resolve(true),
        },
      ]);
      return;
    }
    showConfirmDialog({
      title: input.title,
      message: input.message,
      confirmText: input.confirmText,
      destructive: input.destructive,
      onCancel: () => resolve(false),
      onConfirm: () => resolve(true),
    });
  });
}

export function ArchivedThreadsRouteScreen() {
  const { expand } = useClerkSettingsSheetDetent();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [sort, setSort] = useState<ArchivedThreadSortState>({
    field: "archivedAt",
    direction: "desc",
  });
  const [busyThreadKeys, setBusyThreadKeys] = useState<ReadonlySet<string>>(() => new Set());
  const environments = useMemo<ReadonlyArray<ArchivedThreadsHeaderEnvironment>>(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        })),
        Order.mapInput(Order.String, (environment: ArchivedThreadsHeaderEnvironment) =>
          environment.label.toLocaleLowerCase(),
        ),
      ),
    [savedConnectionsById],
  );
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(environmentIds);
  const search = useMemo(() => parseArchivedThreadSearchInput(searchQuery), [searchQuery]);
  const groups = useMemo(
    () =>
      buildArchivedThreadGroups({
        snapshots,
        environmentId: selectedEnvironmentId,
        search,
        sort,
      }),
    [search, selectedEnvironmentId, snapshots, sort],
  );
  const refreshChangedEnvironment = useCallback(
    (thread: { readonly environmentId: EnvironmentId }) => {
      refreshArchivedThreadsForEnvironment(thread.environmentId);
    },
    [],
  );
  const { unarchiveThread, deleteThread, confirmDeleteThread } =
    useArchivedThreadListActions(refreshChangedEnvironment);
  const updateBusyThreads = useCallback(
    (threads: ReadonlyArray<EnvironmentThreadShell>, busy: boolean) => {
      setBusyThreadKeys((current) => {
        const next = new Set(current);
        for (const thread of threads) {
          const key = scopedThreadKey(thread.environmentId, thread.id);
          if (busy) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    },
    [],
  );
  const handleUnarchiveThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      updateBusyThreads([thread], true);
      try {
        await unarchiveThread(thread);
      } finally {
        updateBusyThreads([thread], false);
      }
    },
    [unarchiveThread, updateBusyThreads],
  );
  const handleProjectAction = useCallback(
    async (
      projectTitle: string,
      threads: ReadonlyArray<EnvironmentThreadShell>,
      scope: "all" | "matching",
      action: "unarchive" | "delete",
    ) => {
      const scopeLabel =
        scope === "matching" ? "matching archived conversations" : "all archived conversations";
      const actionLabel = action === "unarchive" ? "Unarchive" : "Delete";
      const confirmed = await confirmArchivedProjectAction({
        title: `${actionLabel} ${scopeLabel}?`,
        message:
          action === "unarchive"
            ? `Restore ${threads.length} conversation${threads.length === 1 ? "" : "s"} from “${projectTitle}”?`
            : `Permanently delete ${threads.length} conversation${threads.length === 1 ? "" : "s"} from “${projectTitle}”? This also clears their terminal history.`,
        confirmText: actionLabel,
        destructive: action === "delete",
      });
      if (!confirmed) return;

      updateBusyThreads(threads, true);
      try {
        const summary = await runArchivedThreadActions(threads, (thread) =>
          action === "unarchive"
            ? unarchiveThread(thread, { reportFailure: false })
            : deleteThread(thread, { reportFailure: false }),
        );
        if (summary.failed > 0) {
          Alert.alert(
            `Archived threads not fully ${action === "unarchive" ? "unarchived" : "deleted"}`,
            `${summary.succeeded} succeeded and ${summary.failed} failed.`,
          );
        }
      } catch (error) {
        Alert.alert(
          `Archived threads not fully ${action === "unarchive" ? "unarchived" : "deleted"}`,
          archivedThreadActionExceptionDescription(error),
        );
      } finally {
        updateBusyThreads(threads, false);
        refresh();
      }
    },
    [deleteThread, refresh, unarchiveThread, updateBusyThreads],
  );

  useFocusEffect(
    useCallback(() => {
      expand();
      refresh();
    }, [expand, refresh]),
  );

  return (
    <ArchivedThreadsScreen
      environments={environments}
      error={error}
      groups={groups}
      isLoading={isLoading}
      onDeleteThread={confirmDeleteThread}
      onEnvironmentChange={setSelectedEnvironmentId}
      onProjectAction={(projectTitle, threads, scope, action) =>
        void handleProjectAction(projectTitle, threads, scope, action)
      }
      onRefresh={refresh}
      onSearchQueryChange={setSearchQuery}
      onSortChange={setSort}
      onUnarchiveThread={(thread) => void handleUnarchiveThread(thread)}
      searchQuery={searchQuery}
      selectedEnvironmentId={selectedEnvironmentId}
      sort={sort}
      busyThreadKeys={busyThreadKeys}
    />
  );
}
