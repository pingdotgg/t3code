import type { WorkspaceState } from "../../state/workspaceModel";

export interface WorkspaceConnectionStatusPresentation {
  readonly label: string;
  readonly showsProgress: boolean;
}

function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  if (state.networkStatus === "offline") return true;
  if (state.hasReadyEnvironment) return state.hasSyncingConnectedEnvironment;
  return (
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

function hopefulConnectingEnvironments(state: WorkspaceState) {
  // A sleeping second machine should not steal the header from one that may still connect.
  const hopeful = state.connectingEnvironments.filter(
    (environment) => environment.connectionError === null,
  );
  return hopeful.length > 0 ? hopeful : state.connectingEnvironments;
}

function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  if (state.networkStatus === "offline") return "You are offline";
  if (state.hasReadyEnvironment && state.hasSyncingConnectedEnvironment) {
    return state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads...";
  }
  const connecting = hopefulConnectingEnvironments(state);
  // Cached threads stay on screen; keep the header quiet while the socket catches up.
  if (
    state.hasLoadedShellSnapshot &&
    connecting.some((environment) => environment.connectionError === null)
  ) {
    return "Updating...";
  }
  if (connecting.length === 1) {
    return `Reconnecting to ${connecting[0]!.environmentLabel}`;
  }
  if (connecting.length > 1) {
    return `Reconnecting ${connecting.length} environments`;
  }
  if (state.connectionError !== null) return state.connectionError;
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads...";
  }
  return "Not connected";
}

export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
): WorkspaceConnectionStatusPresentation | null {
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  const hopeful = hopefulConnectingEnvironments(state);
  const hasHopefulConnect = hopeful.some((environment) => environment.connectionError === null);
  return {
    label: workspaceConnectionStatusLabel(state),
    showsProgress:
      state.networkStatus !== "offline" &&
      (state.hasReadyEnvironment || state.connectionError === null || hasHopefulConnect) &&
      (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot),
  };
}
