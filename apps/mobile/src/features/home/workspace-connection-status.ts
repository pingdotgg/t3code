import { environmentIsUnreachable, type WorkspaceState } from "../../state/workspaceModel";

export interface WorkspaceConnectionStatusPresentation {
  readonly label: string;
  readonly showsProgress: boolean;
}

function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  if (state.networkStatus === "offline") return true;
  // One connected environment keeps the app usable, so another that is asleep
  // or unreachable is reported on its own rows instead of taking the title.
  // Its retries also mark its shell as pending, so only a connected
  // environment's sync counts here.
  if (state.hasReadyEnvironment) return state.hasSyncingConnectedEnvironment;
  return (
    state.hasPendingShellSnapshot ||
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasLoadedShellSnapshot
  );
}

function connectingEnvironmentsLabel(
  environments: WorkspaceState["connectingEnvironments"],
): string | null {
  if (environments.length === 0) return null;
  // After a failed attempt the retries continue in the background, possibly
  // for hours, so the label stops promising a reconnect.
  const unreachable = environments.every(environmentIsUnreachable);
  if (environments.length === 1) {
    const label = environments[0]!.environmentLabel;
    return unreachable ? `${label} is unreachable` : `Reconnecting to ${label}`;
  }
  return unreachable
    ? `${environments.length} environments unreachable`
    : `Reconnecting ${environments.length} environments`;
}

function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  if (state.networkStatus === "offline") return "You are offline";
  if (!state.hasReadyEnvironment) {
    const connectingLabel = connectingEnvironmentsLabel(state.connectingEnvironments);
    if (connectingLabel !== null) return connectingLabel;
    if (state.connectionError !== null) return state.connectionError;
  }
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads...";
  }
  return "Not connected";
}

function showsConnectionProgress(state: WorkspaceState): boolean {
  if (state.networkStatus === "offline") return false;
  // Only shell sync reaches the title while an environment is connected.
  if (state.hasReadyEnvironment) return true;
  if (state.connectingEnvironments.length > 0) {
    return !state.connectingEnvironments.every(environmentIsUnreachable);
  }
  return state.connectionError === null && state.hasPendingShellSnapshot;
}

export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
): WorkspaceConnectionStatusPresentation | null {
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  return {
    label: workspaceConnectionStatusLabel(state),
    showsProgress: showsConnectionProgress(state),
  };
}
