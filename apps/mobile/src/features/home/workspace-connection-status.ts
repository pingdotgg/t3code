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
 * Whether the status describes work in progress rather than a steady state.
 *
 * Only these need settling before they reach the UI: they are driven by the
 * shell-sync signal, which re-enters "synchronizing" on every websocket
 * resubscribe and retries expected failures every 250ms, so a healthy
 * connection still emits a stream of sub-second blips. Everything else is a
 * steady fact and should surface immediately.
 */
export function isWorkspaceConnectionStatusBusy(state: WorkspaceState): boolean {
  return (
    state.networkStatus !== "offline" &&
    state.connectionError === null &&
    (state.hasConnectingEnvironment ||
      state.connectingEnvironments.length > 0 ||
      state.hasPendingShellSnapshot)
  );
}

const SYNCED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** Clock time for the resting status, or null when the timestamp is unusable. */
export function formatWorkspaceSyncedAt(isoTimestamp: string | null): string | null {
  if (isoTimestamp === null) return null;
  const parsed = Date.parse(isoTimestamp);
  return Number.isNaN(parsed) ? null : SYNCED_AT_FORMATTER.format(parsed);
}

/**
 * Label for the pinned status bar, which stays mounted in every state.
 *
 * At rest it reports what synced and when, rather than going blank — a quiet
 * bar should still answer "am I up to date?" instead of leaving the user to
 * infer it from an absence. Everything else defers to the existing connection
 * label, which already words each problem case.
 */
export function workspaceSyncStatusLabel(state: WorkspaceState): string {
  if (shouldShowWorkspaceConnectionStatus(state)) {
    return workspaceConnectionStatusLabel(state);
  }

  const environments =
    state.readyEnvironmentCount === 1
      ? "1 environment"
      : `${state.readyEnvironmentCount} environments`;
  const syncedAt = formatWorkspaceSyncedAt(state.latestCachedSnapshotReceivedAt);
  // A cold start that never recorded a snapshot time still reports the
  // connection count rather than inventing a timestamp.
  return syncedAt === null ? `Synced ${environments}` : `Synced ${environments} at ${syncedAt}`;
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
