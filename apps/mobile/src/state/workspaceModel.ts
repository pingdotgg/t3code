import { type EnvironmentShellSummary } from "@t3tools/client-runtime/state/shell";
import { type NetworkStatus } from "@t3tools/client-runtime/connection";
import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import type { EnvironmentPresentation } from "./environments";

export interface WorkspaceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly isRelayManaged: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
}

export interface WorkspaceState {
  readonly isLoadingConnections: boolean;
  readonly hasConnections: boolean;
  readonly hasLoadedShellSnapshot: boolean;
  readonly hasPendingShellSnapshot: boolean;
  readonly hasReadyEnvironment: boolean;
  readonly hasConnectingEnvironment: boolean;
  readonly connectingEnvironments: ReadonlyArray<WorkspaceEnvironment>;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly shellSnapshotError: string | null;
  readonly latestCachedSnapshotReceivedAt: string | null;
  readonly networkStatus: NetworkStatus;
}

export function projectWorkspaceEnvironment(
  environment: EnvironmentPresentation,
): WorkspaceEnvironment {
  return {
    environmentId: environment.environmentId,
    environmentLabel: environment.label,
    displayUrl: environment.displayUrl ?? "",
    isRelayManaged: environment.relayManaged,
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
  if (environments.some((environment) => environment.connectionState === "error")) {
    return "error";
  }
  if (environments.some((environment) => environment.connectionState === "offline")) {
    return "offline";
  }
  return "available";
}

export function projectWorkspaceState(input: {
  readonly isReady: boolean;
  readonly networkStatus: NetworkStatus;
  readonly environments: ReadonlyArray<WorkspaceEnvironment>;
  readonly shellSummary: EnvironmentShellSummary;
}): WorkspaceState {
  const connectingEnvironments = input.environments.filter(
    (environment) =>
      environment.connectionState === "connecting" ||
      environment.connectionState === "reconnecting",
  );

  return {
    isLoadingConnections: !input.isReady,
    hasConnections: input.environments.length > 0,
    hasLoadedShellSnapshot: input.shellSummary.hasSnapshot,
    hasPendingShellSnapshot: input.shellSummary.hasSynchronizingShell,
    hasReadyEnvironment:
      input.networkStatus !== "offline" &&
      input.environments.some((environment) => environment.connectionState === "connected"),
    hasConnectingEnvironment: connectingEnvironments.length > 0,
    connectingEnvironments,
    connectionState: overallConnectionState(input.environments, input.networkStatus),
    connectionError:
      input.environments.find((environment) => environment.connectionError !== null)
        ?.connectionError ?? null,
    shellSnapshotError: input.shellSummary.firstError,
    latestCachedSnapshotReceivedAt: input.shellSummary.latestSnapshotUpdatedAt,
    networkStatus: input.networkStatus,
  };
}

export type ServerConfigByEnvironmentId = ReadonlyMap<EnvironmentId, ServerConfig>;
