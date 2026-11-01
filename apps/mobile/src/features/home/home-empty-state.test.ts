import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceState } from "../../state/workspaceModel";
import { deriveEmptyState } from "./home-empty-state";

function workspaceState(overrides: Partial<WorkspaceState>): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: false,
    hasPendingShellSnapshot: false,
    hasSyncingConnectedEnvironment: false,
    hasReadyEnvironment: false,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    networkStatus: "online",
    ...overrides,
  };
}

describe("home empty state", () => {
  it("shows a loading state, not an empty thread list, while retrying a failed first connect", () => {
    const emptyState = deriveEmptyState({
      catalogState: workspaceState({
        connectionState: "reconnecting",
        hasConnectingEnvironment: true,
        connectionError: "Could not reach fs-42",
      }),
      projectCount: 0,
    });

    expect(emptyState.title).not.toBe("No threads yet");
    expect(emptyState.loading).toBe(true);
  });

  it("shows a loading state, not an empty thread list, while the first snapshot is still loading", () => {
    const emptyState = deriveEmptyState({
      catalogState: workspaceState({
        connectionState: "connected",
        hasReadyEnvironment: true,
        hasPendingShellSnapshot: true,
      }),
      projectCount: 0,
    });

    expect(emptyState.title).not.toBe("No threads yet");
    expect(emptyState.loading).toBe(true);
  });
});
