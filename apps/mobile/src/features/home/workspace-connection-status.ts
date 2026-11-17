import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import { runtimeConnectionErrorText } from "../connection/environmentStatusText";
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

function workspaceConnectionStatusLabel(state: WorkspaceState, resolve: MessageResolver): string {
  if (state.networkStatus === "offline") return resolve(msg("You are offline"));
  if (state.hasReadyEnvironment && state.hasSyncingConnectedEnvironment) {
    return state.hasLoadedShellSnapshot
      ? resolve(msg("Syncing threads..."))
      : resolve(msg("Loading threads..."));
  }
  if (state.connectingEnvironments.length === 1) {
    return resolve(
      msg("Reconnecting to {environment}", {
        environment: state.connectingEnvironments[0]!.environmentLabel,
      }),
    );
  }
  if (state.connectingEnvironments.length > 1) {
    return resolve(
      msg(
        "{count, plural, one {Reconnecting {count} environment} other {Reconnecting {count} environments}}",
        { count: state.connectingEnvironments.length },
      ),
    );
  }
  const connectionError = runtimeConnectionErrorText(state, resolve);
  if (connectionError !== null) return connectionError;
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot
      ? resolve(msg("Syncing threads..."))
      : resolve(msg("Loading threads..."));
  }
  return resolve(msg("Not connected"));
}

export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
  resolve: MessageResolver = m,
): WorkspaceConnectionStatusPresentation | null {
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  return {
    label: workspaceConnectionStatusLabel(state, resolve),
    showsProgress:
      state.networkStatus !== "offline" &&
      (state.hasReadyEnvironment || state.connectionError === null) &&
      (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot),
  };
}
