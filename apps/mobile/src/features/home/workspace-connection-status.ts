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

/**
 * What the workspace sync indicator should currently convey.
 *
 * "idle" means there is nothing worth reporting — the indicator renders no
 * content in that state rather than unmounting, so its slot in the header
 * never reflows its neighbours.
 */
export type WorkspaceSyncTone =
  | "offline"
  | "error"
  | "disconnected"
  | "connecting"
  | "syncing"
  | "idle";

export function workspaceSyncTone(state: WorkspaceState): WorkspaceSyncTone {
  if (state.networkStatus === "offline") return "offline";
  if (state.connectionError !== null) return "error";
  if (state.connectingEnvironments.length > 0 || state.hasConnectingEnvironment) return "connecting";
  if (state.hasPendingShellSnapshot) return "syncing";
  if (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment) return "disconnected";
  return "idle";
}

/**
 * Tones that describe work in progress. These are the ones driven by the
 * shell-sync signal, which toggles on every websocket resubscribe and on a
 * 250ms retry cycle — they need settling before they reach the UI (see
 * useSettledWorkspaceSyncTone). The rest are steady-state facts about a real
 * problem and should surface immediately.
 */
export function isTransientWorkspaceSyncTone(tone: WorkspaceSyncTone): boolean {
  return tone === "connecting" || tone === "syncing";
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
