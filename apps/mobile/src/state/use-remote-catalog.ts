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
import { useShellSnapshotStates } from "./use-shell-snapshot";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentState,
} from "./use-remote-environment-registry";

const projectsSortOrder = Order.make<EnvironmentScopedProjectShell>(
  (left, right) =>
    (left.title.localeCompare(right.title) as -1 | 0 | 1) ||
    (left.environmentId.localeCompare(right.environmentId) as -1 | 0 | 1),
);

const threadsSortOrder = Order.make<EnvironmentScopedThreadShell>(
  (left, right) =>
    ((new Date(right.updatedAt ?? right.createdAt).getTime() -
      new Date(left.updatedAt ?? left.createdAt).getTime()) as -1 | 0 | 1) ||
    (left.environmentId.localeCompare(right.environmentId) as -1 | 0 | 1),
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

export function useRemoteCatalog() {
  const { connectedEnvironments, connectionState } = useRemoteConnectionStatus();
  const { environmentStateById, savedConnectionsById } = useRemoteEnvironmentState();
  const shellSnapshotStates = useShellSnapshotStates(Object.keys(savedConnectionsById));

  const projects = useMemo(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).flatMap((connection) =>
          (shellSnapshotStates[connection.environmentId]?.data?.projects ?? []).map((project) =>
            scopeProjectShell(connection.environmentId, project),
          ),
        ),
        projectsSortOrder,
      ),
    [savedConnectionsById, shellSnapshotStates],
  );

  const threads = useMemo(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).flatMap((connection) =>
          (shellSnapshotStates[connection.environmentId]?.data?.threads ?? []).map((thread) =>
            scopeThreadShell(connection.environmentId, thread),
          ),
        ),
        threadsSortOrder,
      ),
    [savedConnectionsById, shellSnapshotStates],
  );

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

  return {
    projects,
    threads,
    serverConfigByEnvironmentId,
    connectionState: connectionState ?? overallConnectionState,
    hasRemoteActivity,
  };
}
