import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceState } from "../../state/workspaceModel";
import { workspaceConnectionStatusPresentation } from "./workspace-connection-status";

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasPendingShellSnapshot: false,
    hasSyncingConnectedEnvironment: false,
    hasReadyEnvironment: true,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    networkStatus: "online",
    ...overrides,
  };
}

function environment(
  overrides: Partial<WorkspaceState["connectingEnvironments"][number]> = {},
): WorkspaceState["connectingEnvironments"][number] {
  return {
    environmentId: "environment-1" as never,
    environmentLabel: "Julius’s Mac mini",
    displayUrl: "",
    isRelayManaged: false,
    isEnabled: true,
    connectionState: "reconnecting",
    connectionError: null,
    connectionErrorTraceId: null,
    ...overrides,
  };
}

describe("workspace connection status", () => {
  it("stays hidden while a ready environment is connected", () => {
    expect(workspaceConnectionStatusPresentation(workspaceState())).toBeNull();
  });

  it("surfaces offline snapshots", () => {
    const state = workspaceState({ networkStatus: "offline", hasReadyEnvironment: false });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "You are offline",
      showsProgress: false,
    });
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
          isEnabled: true,
          connectionState: "reconnecting",
          connectionError: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Reconnecting to Julius’s Mac mini",
      showsProgress: true,
    });
  });

  it("stays hidden while another environment is connected", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      connectingEnvironments: [environment({ connectionError: "Timed out" })],
      connectionError: "Timed out",
    });

    expect(workspaceConnectionStatusPresentation(state)).toBeNull();
  });

  it("ignores the pending shell of an environment that is only being retried", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasPendingShellSnapshot: true,
      connectingEnvironments: [environment({ connectionError: "Timed out" })],
      connectionError: "Timed out",
    });

    expect(workspaceConnectionStatusPresentation(state)).toBeNull();
  });

  it("reports sync of a connected environment while another is unreachable", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasPendingShellSnapshot: true,
      hasSyncingConnectedEnvironment: true,
      connectingEnvironments: [environment({ connectionError: "Timed out" })],
      connectionError: "Timed out",
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Syncing threads...",
      showsProgress: true,
    });
  });

  it("stops promising a reconnect once an attempt has failed", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasReadyEnvironment: false,
      connectingEnvironments: [environment({ connectionError: "Timed out" })],
      connectionError: "Timed out",
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Julius’s Mac mini is unreachable",
      showsProgress: false,
    });
  });

  it("keeps reconnecting while any environment is still on a first attempt", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasReadyEnvironment: false,
      connectingEnvironments: [
        environment({ connectionError: "Timed out" }),
        environment({ environmentId: "environment-2" as never, connectionState: "connecting" }),
      ],
      connectionError: "Timed out",
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Reconnecting 2 environments",
      showsProgress: true,
    });
  });

  it("surfaces connection errors before the generic disconnected fallback", () => {
    const state = workspaceState({
      connectionError: "Could not reach Julius’s Mac mini",
      hasLoadedShellSnapshot: false,
      hasReadyEnvironment: false,
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Could not reach Julius’s Mac mini",
      showsProgress: false,
    });
  });

  it("shows shell catch-up while cached threads remain visible", () => {
    const state = workspaceState({
      hasPendingShellSnapshot: true,
      hasSyncingConnectedEnvironment: true,
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Syncing threads...",
      showsProgress: true,
    });
  });

  it("distinguishes initial shell loading from cached catch-up", () => {
    const state = workspaceState({
      hasLoadedShellSnapshot: false,
      hasPendingShellSnapshot: true,
      hasSyncingConnectedEnvironment: true,
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Loading threads...",
      showsProgress: true,
    });
  });
});
