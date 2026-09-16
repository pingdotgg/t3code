import { type EnvironmentShellSummary } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import {
  connectionCatalogDisplayUrl,
  type EnvironmentPresentation,
  type EnvironmentConnectionPhase,
  type NetworkStatus,
} from "@t3tools/client-runtime/connection";

export interface WorkspaceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly isRelayManaged: boolean;
  readonly isEnabled: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
}

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
  readonly shellSnapshotError: string | null;
  readonly latestCachedSnapshotReceivedAt: string | null;
}

export function projectWorkspaceEnvironment(
  environmentId: EnvironmentId,
  environment: EnvironmentPresentation,
): WorkspaceEnvironment {
  return {
    environmentId,
    environmentLabel: environment.entry.target.label,
    displayUrl: connectionCatalogDisplayUrl(environment.entry) ?? "",
    isRelayManaged: environment.entry.target._tag === "RelayConnectionTarget",
    isEnabled: environment.entry.enabled,
    connectionState: environment.connection.phase,
    connectionError: environment.connection.error,
    connectionErrorTraceId: environment.connection.traceId,
  };
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
  // Switched-off environments still count as saved connections, but they do
  // not drive the overall connection state or surface their last error.
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
}): WorkspaceState {
  return {
    ...projectWorkspaceConnectionState(input),
    hasLoadedShellSnapshot: input.shellSummary.hasSnapshot,
    hasPendingShellSnapshot: input.shellSummary.hasSynchronizingShell,
    shellSnapshotError: input.shellSummary.firstError,
    latestCachedSnapshotReceivedAt: input.shellSummary.latestSnapshotUpdatedAt,
  };
}

export type ServerConfigByEnvironmentId = ReadonlyMap<EnvironmentId, ServerConfig>;
