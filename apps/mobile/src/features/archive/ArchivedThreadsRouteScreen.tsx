import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";

import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useClerkSettingsSheetDetent } from "../cloud/ClerkSettingsSheetDetent";
import { useArchivedThreadListActions } from "../home/useThreadListActions";
import {
  ArchivedThreadsScreen,
  type ArchivedThreadsHeaderEnvironment,
} from "./ArchivedThreadsScreen";
import { buildArchivedThreadGroups, type ArchivedThreadSortOrder } from "./archivedThreadList";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "./useArchivedThreadSnapshots";

export function ArchivedThreadsRouteScreen() {
  const { expand } = useClerkSettingsSheetDetent();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [sortOrder, setSortOrder] = useState<ArchivedThreadSortOrder>("newest");
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
  const environmentLabels = useMemo(
    () =>
      Object.fromEntries(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [environments],
  );
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(environmentIds);
  const groups = useMemo(
    () =>
      buildArchivedThreadGroups({
        snapshots,
        environmentLabels,
        environmentId: selectedEnvironmentId,
        searchQuery,
        sortOrder,
      }),
    [environmentLabels, searchQuery, selectedEnvironmentId, snapshots, sortOrder],
  );
  const refreshChangedEnvironment = useCallback(
    (thread: { readonly environmentId: EnvironmentId }) => {
      refreshArchivedThreadsForEnvironment(thread.environmentId);
    },
    [],
  );
  const { unarchiveThread, confirmDeleteThread } =
    useArchivedThreadListActions(refreshChangedEnvironment);

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
      onRefresh={refresh}
      onSearchQueryChange={setSearchQuery}
      onSortOrderChange={setSortOrder}
      onUnarchiveThread={unarchiveThread}
      searchQuery={searchQuery}
      selectedEnvironmentId={selectedEnvironmentId}
      sortOrder={sortOrder}
    />
  );
}
