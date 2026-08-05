import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import type { WorkspaceState } from "../../state/workspaceModel";

export function resolveHomeEnvironmentConnectionPhase(
  connectionState: EnvironmentConnectionPhase | undefined,
  isLoadingConnections: boolean,
): EnvironmentConnectionPhase {
  return connectionState ?? (isLoadingConnections ? "connecting" : "available");
}

export function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  return (
    state.networkStatus === "offline" ||
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

export function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  if (state.networkStatus === "offline") return "You are offline";
  if (state.connectingEnvironments.length === 1) {
    return `Reconnecting to ${state.connectingEnvironments[0]!.environmentLabel}`;
  }
  if (state.connectingEnvironments.length > 1) {
    return `Reconnecting ${state.connectingEnvironments.length} environments`;
  }
  if (state.connectionError !== null) return state.connectionError;
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads...";
  }
  return "Not connected";
}

export interface WorkspaceConnectionHeaderPresentation {
  readonly detail: "reconnecting" | "unreachable";
  readonly label: string;
  readonly tone: "amber" | "red";
}

/**
 * Only actual connection trouble displaces the Home wordmark. Shell catch-up
 * is healthy background work and deliberately leaves the header unchanged.
 */
export function workspaceConnectionHeaderPresentation(
  state: WorkspaceState,
  environmentLabel?: string,
  environmentConnectionState?: EnvironmentConnectionPhase,
): WorkspaceConnectionHeaderPresentation | null {
  if (state.networkStatus === "offline") {
    return {
      detail: "unreachable",
      label: environmentLabel ?? "Network",
      tone: "red",
    };
  }

  if (
    environmentConnectionState === "connecting" ||
    environmentConnectionState === "reconnecting"
  ) {
    return {
      detail: "reconnecting",
      label: environmentLabel ?? "Environment",
      tone: "amber",
    };
  }

  if (environmentConnectionState && environmentConnectionState !== "connected") {
    return {
      detail: "unreachable",
      label: environmentLabel ?? "Environment",
      tone: "red",
    };
  }

  if (state.connectingEnvironments.length > 0) {
    const connecting = state.connectingEnvironments[0];
    return {
      detail: "reconnecting",
      label:
        state.connectingEnvironments.length === 1
          ? (connecting?.environmentLabel ?? environmentLabel ?? "Environment")
          : `${state.connectingEnvironments.length} environments`,
      tone: "amber",
    };
  }

  if (
    state.connectionError !== null ||
    (state.hasConnections && state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  ) {
    return {
      detail: "unreachable",
      label: environmentLabel ?? "Environment",
      tone: "red",
    };
  }

  return null;
}
