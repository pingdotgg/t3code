import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceState } from "../../state/workspaceModel";
import {
  resolveHomeEnvironmentConnectionPhase,
  shouldShowWorkspaceConnectionStatus,
  workspaceConnectionHeaderPresentation,
  workspaceConnectionStatusLabel,
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
  it("treats uncatalogued saved environments as connecting during startup", () => {
    expect(resolveHomeEnvironmentConnectionPhase(undefined, true)).toBe("connecting");
    expect(resolveHomeEnvironmentConnectionPhase(undefined, false)).toBe("available");
    expect(resolveHomeEnvironmentConnectionPhase("connected", true)).toBe("connected");
  });

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

  it("keeps healthy shell synchronization out of the Home wordmark", () => {
    const state = workspaceState({ hasPendingShellSnapshot: true });

    expect(workspaceConnectionHeaderPresentation(state, "Leftbook")).toBeNull();
  });

  it("presents reconnecting environments in amber", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "Leftbook",
          displayUrl: "",
          isRelayManaged: false,
          connectionState: "reconnecting",
          connectionError: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionHeaderPresentation(state, "Other device")).toEqual({
      detail: "reconnecting",
      label: "Leftbook",
      tone: "amber",
    });
  });

  it("presents unreachable environments in red", () => {
    const state = workspaceState({
      connectionError: "Connection refused",
      hasReadyEnvironment: false,
    });

    expect(workspaceConnectionHeaderPresentation(state, "Steambox")).toEqual({
      detail: "unreachable",
      label: "Steambox",
      tone: "red",
    });
  });

  it("surfaces one unavailable device while other environments stay connected", () => {
    const state = workspaceState();

    expect(workspaceConnectionHeaderPresentation(state, "Steambox", "available")).toEqual({
      detail: "unreachable",
      label: "Steambox",
      tone: "red",
    });
  });
});
