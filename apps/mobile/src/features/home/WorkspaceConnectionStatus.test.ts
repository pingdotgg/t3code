import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceState } from "../../state/workspaceModel";
import {
  isTransientWorkspaceSyncTone,
  shouldShowWorkspaceConnectionStatus,
  workspaceConnectionStatusLabel,
  workspaceSyncTone,
} from "./workspace-connection-status";

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasPendingShellSnapshot: false,
    hasReadyEnvironment: true,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    latestCachedSnapshotReceivedAt: null,
    networkStatus: "online",
    ...overrides,
  };
}

describe("workspace connection status", () => {
  it("stays hidden while a ready environment is connected", () => {
    expect(shouldShowWorkspaceConnectionStatus(workspaceState())).toBe(false);
  });

  it("surfaces offline snapshots", () => {
    const state = workspaceState({ networkStatus: "offline", hasReadyEnvironment: false });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("You are offline");
  });

  it("names the environment while reconnecting", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasReadyEnvironment: false,
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "Julius’s Mac mini",
          displayUrl: "",
          isRelayManaged: false,
          connectionState: "reconnecting",
          connectionError: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("Reconnecting to Julius’s Mac mini");
  });

  it("surfaces connection errors before the generic disconnected fallback", () => {
    const state = workspaceState({
      connectionError: "Could not reach Julius’s Mac mini",
      hasLoadedShellSnapshot: false,
      hasReadyEnvironment: false,
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("Could not reach Julius’s Mac mini");
  });

  it("shows shell catch-up while cached threads remain visible", () => {
    const state = workspaceState({ hasPendingShellSnapshot: true });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("Syncing threads...");
  });

  it("distinguishes initial shell loading from cached catch-up", () => {
    const state = workspaceState({
      hasLoadedShellSnapshot: false,
      hasPendingShellSnapshot: true,
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("Loading threads...");
  });
});

describe("workspace sync tone", () => {
  it("is idle while a ready environment is connected", () => {
    expect(workspaceSyncTone(workspaceState())).toBe("idle");
  });

  it("reports offline ahead of every other state", () => {
    const state = workspaceState({
      networkStatus: "offline",
      connectionError: "Could not reach Julius’s Mac mini",
      hasPendingShellSnapshot: true,
      hasReadyEnvironment: false,
    });

    expect(workspaceSyncTone(state)).toBe("offline");
  });

  it("reports a connection error ahead of in-progress work", () => {
    const state = workspaceState({
      connectionError: "Could not reach Julius’s Mac mini",
      hasPendingShellSnapshot: true,
      hasReadyEnvironment: false,
    });

    expect(workspaceSyncTone(state)).toBe("error");
  });

  it("reports connecting ahead of shell sync", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasPendingShellSnapshot: true,
      hasReadyEnvironment: false,
    });

    expect(workspaceSyncTone(state)).toBe("connecting");
  });

  it("reports shell catch-up as syncing", () => {
    expect(workspaceSyncTone(workspaceState({ hasPendingShellSnapshot: true }))).toBe("syncing");
  });

  it("falls back to disconnected once a snapshot loaded without a ready environment", () => {
    const state = workspaceState({ hasReadyEnvironment: false });

    expect(workspaceSyncTone(state)).toBe("disconnected");
  });

  // Only these two are driven by the bouncy shell-sync signal, so only these
  // get settled before reaching the header (useSettledWorkspaceSyncTone).
  it("treats only connecting and syncing as transient", () => {
    expect(isTransientWorkspaceSyncTone("connecting")).toBe(true);
    expect(isTransientWorkspaceSyncTone("syncing")).toBe(true);
    expect(isTransientWorkspaceSyncTone("offline")).toBe(false);
    expect(isTransientWorkspaceSyncTone("error")).toBe(false);
    expect(isTransientWorkspaceSyncTone("disconnected")).toBe(false);
    expect(isTransientWorkspaceSyncTone("idle")).toBe(false);
  });
});
