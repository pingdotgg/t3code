import type { WorkspaceState } from "../../state/workspaceModel";

export function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  return (
    state.networkStatus === "offline" ||
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

export type WorkspaceConnectionStatusPresentation = "hidden" | "deferred" | "immediate";

/**
 * Brief reconnects are delayed so a healthy foreground probe never flashes
 * transient chrome. Offline/error states remain immediate because they are
 * actionable and may persist.
 */
export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
): WorkspaceConnectionStatusPresentation {
  if (!shouldShowWorkspaceConnectionStatus(state)) return "hidden";
  if (
    state.networkStatus === "offline" ||
    state.connectionError !== null ||
    (!state.hasConnectingEnvironment && !state.hasPendingShellSnapshot)
  ) {
    return "immediate";
  }
  return "deferred";
}

export function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  if (state.networkStatus === "offline") return "You are offline";
  if (state.connectingEnvironments.length === 1) {
    const environment = state.connectingEnvironments[0]!;
    return environment.connectionState === "connecting"
      ? `Connecting to ${environment.environmentLabel}`
      : `Reconnecting to ${environment.environmentLabel}`;
  }
  if (state.connectingEnvironments.length > 1) {
    const isInitialConnection = state.connectingEnvironments.every(
      (environment) => environment.connectionState === "connecting",
    );
    return `${isInitialConnection ? "Connecting to" : "Reconnecting"} ${
      state.connectingEnvironments.length
    } environments`;
  }
  if (state.connectionError !== null) return state.connectionError;
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads...";
  }
  return "Not connected";
}
