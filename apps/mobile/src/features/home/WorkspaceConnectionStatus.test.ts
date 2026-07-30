import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceState } from "../../state/workspaceModel";
import {
  isWorkspaceConnectionStatusBusy,
  shouldShowWorkspaceConnectionStatus,
  workspaceConnectionStatusLabel,
  workspaceSyncStatusLabel,
} from "./workspace-connection-status";

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasPendingShellSnapshot: false,
    hasReadyEnvironment: true,
    readyEnvironmentCount: 1,
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

describe("workspace status bar label", () => {
  // The bar is always on screen, so a quiet workspace still has to say
  // something useful — the plain connection label falls through to
  // "Not connected", which would misreport a healthy sync.
  it("reports what synced and when at rest", () => {
    const state = workspaceState({
      readyEnvironmentCount: 2,
      latestCachedSnapshotReceivedAt: "2026-07-30T15:41:00.000Z",
    });

    expect(workspaceSyncStatusLabel(state)).toMatch(/^Synced 2 environments at .+$/);
  });

  it("singularises a lone environment", () => {
    const state = workspaceState({
      readyEnvironmentCount: 1,
      latestCachedSnapshotReceivedAt: "2026-07-30T15:41:00.000Z",
    });

    expect(workspaceSyncStatusLabel(state)).toMatch(/^Synced 1 environment at .+$/);
  });

  it("omits the time when no snapshot timestamp was recorded", () => {
    const state = workspaceState({ readyEnvironmentCount: 3 });

    expect(workspaceSyncStatusLabel(state)).toBe("Synced 3 environments");
  });

  it("omits the time when the recorded timestamp is unparseable", () => {
    const state = workspaceState({
      readyEnvironmentCount: 1,
      latestCachedSnapshotReceivedAt: "not-a-date",
    });

    expect(workspaceSyncStatusLabel(state)).toBe("Synced 1 environment");
  });

  it("defers to the connection label whenever there is something to report", () => {
    expect(workspaceSyncStatusLabel(workspaceState({ hasPendingShellSnapshot: true }))).toBe(
      "Syncing threads...",
    );
    expect(
      workspaceSyncStatusLabel(
        workspaceState({ networkStatus: "offline", hasReadyEnvironment: false }),
      ),
    ).toBe("You are offline");
  });
});

describe("workspace status busy-ness", () => {
  // Only these get damped before rendering; everything else is a steady fact.
  it("treats in-flight sync and reconnects as busy", () => {
    expect(isWorkspaceConnectionStatusBusy(workspaceState({ hasPendingShellSnapshot: true }))).toBe(
      true,
    );
    expect(
      isWorkspaceConnectionStatusBusy(workspaceState({ hasConnectingEnvironment: true })),
    ).toBe(true);
  });

  it("does not treat a settled workspace as busy", () => {
    expect(isWorkspaceConnectionStatusBusy(workspaceState())).toBe(false);
  });

  it("does not treat real faults as busy, so they surface immediately", () => {
    expect(
      isWorkspaceConnectionStatusBusy(
        workspaceState({ networkStatus: "offline", hasPendingShellSnapshot: true }),
      ),
    ).toBe(false);
    expect(
      isWorkspaceConnectionStatusBusy(
        workspaceState({ connectionError: "boom", hasPendingShellSnapshot: true }),
      ),
    ).toBe(false);
  });
});
