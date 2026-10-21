import { type EnvironmentShellSummary } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import {
  type EnvironmentConnectionPhase,
  type NetworkStatus,
} from "@t3tools/client-runtime/connection";

import type { EnvironmentConnectionSummary as WorkspaceEnvironment } from "@t3tools/client-runtime/state/presentation";

export { projectEnvironmentConnectionSummary as projectWorkspaceEnvironment } from "@t3tools/client-runtime/state/presentation";
export type { EnvironmentConnectionSummary as WorkspaceEnvironment } from "@t3tools/client-runtime/state/presentation";

export interface WorkspaceConnectionState {
  readonly isLoadingConnections: boolean;
  readonly hasConnections: boolean;
  readonly hasReadyEnvironment: boolean;
  readonly hasConnectingEnvironment: boolean;
  readonly connectingEnvironments: ReadonlyArray<WorkspaceEnvironment>;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly networkStatus: NetworkStatus;
}

export interface WorkspaceState extends WorkspaceConnectionState {
  readonly hasLoadedShellSnapshot: boolean;
  readonly hasPendingShellSnapshot: boolean;
  readonly hasSyncingConnectedEnvironment: boolean;
  readonly shellSnapshotError: string | null;
}

function overallConnectionState(
  environments: ReadonlyArray<WorkspaceEnvironment>,
  networkStatus: NetworkStatus,
): EnvironmentConnectionPhase {
  if (environments.length === 0) {
    return "available";
  }
  if (networkStatus === "offline") {
    return "offline";
  }
  if (environments.some((environment) => environment.connectionState === "connected")) {
    return "connected";
  }
  if (environments.some((environment) => environment.connectionState === "reconnecting")) {
    return "reconnecting";
  }
  if (environments.some((environment) => environment.connectionState === "connecting")) {
    return "connecting";
  }
  if (environments.some((environment) => environment.connectionState === "unsupported")) {
    return "unsupported";
  }
  if (environments.some((environment) => environment.connectionState === "error")) {
    return "error";
  }
  if (environments.some((environment) => environment.connectionState === "offline")) {
    return "offline";
  }
  return "available";
}

export function projectWorkspaceConnectionState(input: {
  readonly isReady: boolean;
  readonly networkStatus: NetworkStatus;
  readonly environments: ReadonlyArray<WorkspaceEnvironment>;
}): WorkspaceConnectionState {
  const activeEnvironments = input.environments.filter((environment) => environment.isEnabled);
  const connectingEnvironments = activeEnvironments.filter(
    (environment) =>
      environment.connectionState === "connecting" ||
      environment.connectionState === "reconnecting",
  );

  return {
    isLoadingConnections: !input.isReady,
    hasConnections: input.environments.length > 0,
    hasReadyEnvironment:
      input.networkStatus !== "offline" &&
      activeEnvironments.some((environment) => environment.connectionState === "connected"),
    hasConnectingEnvironment: connectingEnvironments.length > 0,
    connectingEnvironments,
    connectionState: overallConnectionState(activeEnvironments, input.networkStatus),
    connectionError:
      activeEnvironments.find((environment) => environment.connectionError !== null)
        ?.connectionError ?? null,
    networkStatus: input.networkStatus,
  };
}

export function projectWorkspaceState(input: {
  readonly isReady: boolean;
  readonly networkStatus: NetworkStatus;
  readonly environments: ReadonlyArray<WorkspaceEnvironment>;
  readonly shellSummary: EnvironmentShellSummary;
  readonly hasSyncingConnectedEnvironment: boolean;
}): WorkspaceState {
  return {
    ...projectWorkspaceConnectionState(input),
    hasLoadedShellSnapshot: input.shellSummary.hasSnapshot,
    hasPendingShellSnapshot: input.shellSummary.hasSynchronizingShell,
    hasSyncingConnectedEnvironment: input.hasSyncingConnectedEnvironment,
    shellSnapshotError: input.shellSummary.firstError,
  };
}

export type ServerConfigByEnvironmentId = ReadonlyMap<EnvironmentId, ServerConfig>;
