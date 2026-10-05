import type { EnvironmentShellSyncStage } from "@t3tools/client-runtime/state/shell";

import type { WorkspaceState } from "../../state/workspaceModel";

export interface WorkspaceConnectionStatusPresentation {
  readonly label: string;
  /** True while actively working (connecting/syncing) — render a spinner. False for offline/error/idle states — render a wifi-slash icon. */
  readonly showsProgress: boolean;
}

function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  return (
    state.networkStatus === "offline" ||
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

const SYNC_STAGE_LABELS: Record<EnvironmentShellSyncStage, string> = {
  waiting: "Waiting for server...",
  reading: "Reading threads...",
  catchingUp: "Catching up...",
};

function workspaceConnectionStatusLabel(state: WorkspaceState, showSyncStage: boolean): string {
  if (state.networkStatus === "offline") return "You are offline";
  if (state.connectingEnvironments.length === 1) {
    return `Reconnecting to ${state.connectingEnvironments[0]!.environmentLabel}`;
  }
  if (state.connectingEnvironments.length > 1) {
    return `Reconnecting ${state.connectingEnvironments.length} environments`;
  }
  if (state.connectionError !== null) return state.connectionError;
  if (state.hasPendingShellSnapshot) {
    if (showSyncStage && state.pendingShellStage !== null) {
      return SYNC_STAGE_LABELS[state.pendingShellStage];
    }
    return state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads...";
  }
  return "Not connected";
}

/**
 * Header-title presentation of the connection state, or null while connected.
 * `showSyncStage` swaps the sync label for the stage it is stuck on; the title
 * sets it only once a sync has run long enough to feel slow.
 */
export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
  options: { readonly showSyncStage?: boolean } = {},
): WorkspaceConnectionStatusPresentation | null {
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  return {
    label: workspaceConnectionStatusLabel(state, options.showSyncStage === true),
    showsProgress:
      state.networkStatus !== "offline" &&
      state.connectionError === null &&
      (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot),
  };
}
