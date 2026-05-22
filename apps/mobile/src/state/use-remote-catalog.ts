import { useMemo } from "react";
import * as Order from "effect/Order";
import * as Arr from "effect/Array";

import {
  EnvironmentConnectionState,
  EnvironmentScopedProjectShell,
  EnvironmentScopedThreadShell,
  scopeProjectShell,
  scopeThreadShell,
} from "@t3tools/client-runtime";

import { ConnectedEnvironmentSummary } from "./remote-runtime-types";
import type { SavedRemoteConnection } from "../lib/connection";
import { useCachedShellSnapshotMetadata, useShellSnapshotStates } from "./use-shell-snapshot";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentState,
} from "./use-remote-environment-registry";

const projectsSortOrder = Order.mapInput(
  Order.Struct({
    title: Order.String,
    environmentId: Order.String,
  }),
  (project: EnvironmentScopedProjectShell) => ({
    title: project.title,
    environmentId: project.environmentId,
  }),
);

const threadsSortOrder = Order.mapInput(
  Order.Struct({
    activityAt: Order.flip(Order.Number),
    environmentId: Order.String,
  }),
  (thread: EnvironmentScopedThreadShell) => ({
    activityAt: new Date(thread.updatedAt ?? thread.createdAt).getTime(),
    environmentId: thread.environmentId,
  }),
);

function deriveOverallConnectionState(
  environments: ReadonlyArray<ConnectedEnvironmentSummary>,
): EnvironmentConnectionState {
  if (environments.length === 0) {
    return "idle";
  }
  if (environments.some((environment) => environment.connectionState === "ready")) {
    return "ready";
  }
  if (environments.some((environment) => environment.connectionState === "reconnecting")) {
    return "reconnecting";
  }
  if (environments.some((environment) => environment.connectionState === "connecting")) {
    return "connecting";
  }
  return "disconnected";
}

function listRemoteCatalogEnvironmentIds(
  savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>,
): ReadonlyArray<SavedRemoteConnection["environmentId"]> {
  const environmentIds: SavedRemoteConnection["environmentId"][] = [];
  for (const connection of Object.values(savedConnectionsById)) {
    environmentIds.push(connection.environmentId);
  }
  return environmentIds;
}

export interface RemoteCatalogState {
  readonly isLoadingSavedConnections: boolean;
  readonly hasSavedConnections: boolean;
  readonly hasLoadedShellSnapshot: boolean;
  readonly hasPendingShellSnapshot: boolean;
  readonly hasReadyEnvironment: boolean;
  readonly hasConnectingEnvironment: boolean;
  readonly connectionState: EnvironmentConnectionState;
  readonly connectionError: string | null;
  readonly shellSnapshotError: string | null;
  readonly isUsingCachedData: boolean;
  readonly latestCachedSnapshotReceivedAt: string | null;
}

export function useRemoteCatalog() {
  const { connectedEnvironments, connectionError, connectionState } = useRemoteConnectionStatus();
  const { environmentStateById, isLoadingSavedConnection, savedConnectionsById } =
    useRemoteEnvironmentState();
  const catalogEnvironmentIds = useMemo(
    () => listRemoteCatalogEnvironmentIds(savedConnectionsById),
    [savedConnectionsById],
  );
  const shellSnapshotStates = useShellSnapshotStates(catalogEnvironmentIds);
  const cachedShellSnapshotMetadata = useCachedShellSnapshotMetadata();

  const projects = useMemo(() => {
    const scopedProjects: EnvironmentScopedProjectShell[] = [];
    for (const connection of Object.values(savedConnectionsById)) {
      const projects = shellSnapshotStates[connection.environmentId]?.data?.projects ?? [];
      for (const project of projects) {
        scopedProjects.push(scopeProjectShell(connection.environmentId, project));
      }
    }
    return Arr.sort(scopedProjects, projectsSortOrder);
  }, [savedConnectionsById, shellSnapshotStates]);

  const threads = useMemo(() => {
    const scopedThreads: EnvironmentScopedThreadShell[] = [];
    for (const connection of Object.values(savedConnectionsById)) {
      const threads = shellSnapshotStates[connection.environmentId]?.data?.threads ?? [];
      for (const thread of threads) {
        scopedThreads.push(scopeThreadShell(connection.environmentId, thread));
      }
    }
    return Arr.sort(scopedThreads, threadsSortOrder);
  }, [savedConnectionsById, shellSnapshotStates]);

  const serverConfigByEnvironmentId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(environmentStateById).map(([environmentId, runtime]) => [
          environmentId,
          runtime.serverConfig ?? null,
        ]),
      ),
    [environmentStateById],
  );

  const overallConnectionState = useMemo(
    () => deriveOverallConnectionState(connectedEnvironments),
    [connectedEnvironments],
  );

  const hasRemoteActivity = useMemo(
    () =>
      threads.some(
        (thread) => thread.session?.status === "running" || thread.session?.status === "starting",
      ),
    [threads],
  );

  const state = useMemo<RemoteCatalogState>(() => {
    const shellSnapshots = Object.values(shellSnapshotStates);
    const cachedSnapshotReceivedAts: string[] = [];
    for (const environmentId of catalogEnvironmentIds) {
      const metadata = cachedShellSnapshotMetadata[environmentId];
      if (metadata) {
        cachedSnapshotReceivedAts.push(metadata.snapshotReceivedAt);
      }
    }
    let shellSnapshotError: string | null = null;
    for (const snapshot of shellSnapshots) {
      if (snapshot.error !== null) {
        shellSnapshotError = snapshot.error;
        break;
      }
    }
    return {
      isLoadingSavedConnections: isLoadingSavedConnection,
      hasSavedConnections: catalogEnvironmentIds.length > 0,
      hasLoadedShellSnapshot: shellSnapshots.some((snapshot) => snapshot.data !== null),
      hasPendingShellSnapshot: shellSnapshots.some((snapshot) => snapshot.isPending),
      hasReadyEnvironment: connectedEnvironments.some(
        (environment) => environment.connectionState === "ready",
      ),
      hasConnectingEnvironment: connectedEnvironments.some(
        (environment) =>
          environment.connectionState === "connecting" ||
          environment.connectionState === "reconnecting",
      ),
      connectionState: connectionState ?? overallConnectionState,
      connectionError,
      shellSnapshotError,
      isUsingCachedData: cachedSnapshotReceivedAts.length > 0,
      latestCachedSnapshotReceivedAt:
        Arr.sort(cachedSnapshotReceivedAts, Order.flip(Order.String))[0] ?? null,
    };
  }, [
    cachedShellSnapshotMetadata,
    catalogEnvironmentIds,
    connectedEnvironments,
    connectionError,
    connectionState,
    isLoadingSavedConnection,
    overallConnectionState,
    shellSnapshotStates,
  ]);

  return {
    projects,
    threads,
    serverConfigByEnvironmentId,
    connectionState: state.connectionState,
    connectionError: state.connectionError,
    state,
    hasRemoteActivity,
  };
}
