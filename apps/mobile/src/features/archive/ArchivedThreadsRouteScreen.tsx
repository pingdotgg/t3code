import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, Platform } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useArchivedThreadListActions } from "../home/useThreadListActions";
import {
  ArchivedThreadsScreen,
  type ArchivedThreadsHeaderEnvironment,
} from "./ArchivedThreadsScreen";
import {
  archivedThreadActionExceptionDescription,
  archivedThreadActionSummaryDescription,
  buildArchivedThreadGroups,
  parseArchivedThreadSearchInput,
  releaseArchivedThreadActionLock,
  runArchivedThreadActions,
  tryAcquireArchivedThreadActionLock,
  type ArchivedThreadSortState,
} from "./archivedThreadList";
import { useArchivedThreadSnapshots } from "./useArchivedThreadSnapshots";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

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
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [sort, setSort] = useState<ArchivedThreadSortState>({
    field: "archivedAt",
    direction: "desc",
  });
  const reservedThreadKeysRef = useRef(new Set<string>());
  const [reservedThreadKeys, setReservedThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
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
  const { unarchiveThread, deleteThread } = useArchivedThreadListActions();
  const tryReserveThreadActions = useCallback(
    (
      threads: ReadonlyArray<EnvironmentThreadShell>,
    ): { readonly start: () => void; readonly finish: () => void } | null => {
      const lock = tryAcquireArchivedThreadActionLock(reservedThreadKeysRef.current, threads);
      if (!lock) {
        Alert.alert(
          "Archive action already in progress",
          "Wait for the current archived thread action to finish.",
        );
        return null;
      }
      setReservedThreadKeys(new Set(reservedThreadKeysRef.current));
      let started = false;
      return {
        start: () => {
          if (started) return;
          started = true;
          setBusyThreadKeys((current) => {
            const next = new Set(current);
            for (const key of lock.keys) next.add(key);
            return next;
          });
        },
        finish: () => {
          releaseArchivedThreadActionLock(reservedThreadKeysRef.current, lock);
          setReservedThreadKeys(new Set(reservedThreadKeysRef.current));
          if (!started) return;
          setBusyThreadKeys((current) => {
            const next = new Set(current);
            for (const key of lock.keys) next.delete(key);
            return next;
          });
        },
      };
    },
    [],
  );
  const showSkippedActionFeedback = useCallback(() => {
    Alert.alert(
      "Archive action already in progress",
      "Wait for the current archived thread action to finish.",
    );
  }, []);
  const handleUnarchiveThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const reservation = tryReserveThreadActions([thread]);
      if (!reservation) return;
      reservation.start();
      try {
        const result = await unarchiveThread(thread);
        if (result === "skipped") showSkippedActionFeedback();
      } finally {
        reservation.finish();
      }
    },
    [showSkippedActionFeedback, tryReserveThreadActions, unarchiveThread],
  );
  const handleDeleteThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const reservation = tryReserveThreadActions([thread]);
      if (!reservation) return;
      try {
        const confirmed = await confirmArchivedProjectAction({
          title: "Delete thread?",
          message: `“${thread.title}” will be permanently deleted, including its terminal history.`,
          confirmText: "Delete",
          destructive: true,
        });
        if (!confirmed) return;
        reservation.start();
        const result = await deleteThread(thread);
        if (result === "skipped") showSkippedActionFeedback();
      } finally {
        reservation.finish();
      }
    },
    [deleteThread, showSkippedActionFeedback, tryReserveThreadActions],
  );
  const handleProjectAction = useCallback(
    async (
      projectTitle: string,
      threads: ReadonlyArray<EnvironmentThreadShell>,
      scope: "all" | "matching",
      action: "unarchive" | "delete",
    ) => {
      const reservation = tryReserveThreadActions(threads);
      if (!reservation) return;
      try {
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

        reservation.start();
        try {
          const summary = await runArchivedThreadActions(threads, (thread) =>
            action === "unarchive"
              ? unarchiveThread(thread, {
                  reportFailure: false,
                  refreshArchivedThreads: false,
                })
              : deleteThread(thread, {
                  reportFailure: false,
                  refreshArchivedThreads: false,
                }),
          );
          if (summary.failed > 0 || summary.skipped > 0) {
            Alert.alert(
              `Archived threads not fully ${action === "unarchive" ? "unarchived" : "deleted"}`,
              archivedThreadActionSummaryDescription(summary),
            );
          }
        } catch (error) {
          Alert.alert(
            `Archived threads not fully ${action === "unarchive" ? "unarchived" : "deleted"}`,
            archivedThreadActionExceptionDescription(error),
          );
        } finally {
          refresh();
        }
      } finally {
        reservation.finish();
      }
    },
    [deleteThread, refresh, tryReserveThreadActions, unarchiveThread],
  );

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  return (
    <ArchivedThreadsScreen
      environments={environments}
      error={error}
      groups={groups}
      isLoading={isLoading}
      onDeleteThread={(thread) => void handleDeleteThread(thread)}
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
      reservedThreadKeys={reservedThreadKeys}
    />
  );
}
