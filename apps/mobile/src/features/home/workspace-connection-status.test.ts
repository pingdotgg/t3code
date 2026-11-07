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

describe("workspace connection status", () => {
  it.each([
    ["reconnecting", "Could not reach sleeping laptop"],
    ["error", "Could not reach sleeping laptop"],
  ] as const)(
    "keeps the brand while a secondary environment is %s (%s)",
    (connectionState, connectionError) => {
      const state = workspaceState({
        hasConnectingEnvironment: connectionState !== "error",
        hasPendingShellSnapshot: true,
        connectionError,
        connectingEnvironments:
          connectionState === "error"
            ? []
            : [
                {
                  environmentId: "environment-2" as never,
                  environmentLabel: "Sleeping laptop",
                  displayUrl: "",
                  isRelayManaged: false,
                  isEnabled: true,
                  connectionState,
                  connectionError,
                  connectionErrorTraceId: null,
                },
              ],
      });

      expect(workspaceConnectionStatusPresentation(state)).toBeNull();
    },
  );

  it("shows connected shell catch-up even while a secondary environment is unreachable", () => {
    const state = workspaceState({
      hasSyncingConnectedEnvironment: true,
      hasPendingShellSnapshot: true,
      hasConnectingEnvironment: true,
      connectionError: "Could not reach sleeping laptop",
      connectingEnvironments: [
        {
          environmentId: "environment-2" as never,
          environmentLabel: "Sleeping laptop",
          displayUrl: "",
          isRelayManaged: false,
          isEnabled: true,
          connectionState: "reconnecting",
          connectionError: "Could not reach sleeping laptop",
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Syncing threads...",
      showsProgress: true,
    });
  });

  it("keeps a quiet Updating label while reconnecting over a cached shell", () => {
    const state = workspaceState({
      hasReadyEnvironment: false,
      hasConnectingEnvironment: true,
      hasLoadedShellSnapshot: true,
      connectionState: "connecting",
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "MacBook",
          displayUrl: "",
          isRelayManaged: false,
          isEnabled: true,
          connectionState: "connecting",
          connectionError: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Updating...",
      showsProgress: true,
    });
  });

  it("names the environment when reconnecting without a cached shell", () => {
    const state = workspaceState({
      hasReadyEnvironment: false,
      hasConnectingEnvironment: true,
      hasLoadedShellSnapshot: false,
      connectionState: "connecting",
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "MacBook",
          displayUrl: "",
          isRelayManaged: false,
          isEnabled: true,
          connectionState: "connecting",
          connectionError: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Reconnecting to MacBook",
      showsProgress: true,
    });
  });

  it("names the environment when a cached reconnect has an error", () => {
    const state = workspaceState({
      hasReadyEnvironment: false,
      hasConnectingEnvironment: true,
      hasLoadedShellSnapshot: true,
      connectionState: "reconnecting",
      connectionError: "Could not reach MacBook",
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "MacBook",
          displayUrl: "",
          isRelayManaged: false,
          isEnabled: true,
          connectionState: "reconnecting",
          connectionError: "Could not reach MacBook",
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Reconnecting to MacBook",
      showsProgress: false,
    });
  });

  it("ignores a failing second environment while a hopeful one is connecting over cache", () => {
    const state = workspaceState({
      hasReadyEnvironment: false,
      hasConnectingEnvironment: true,
      hasLoadedShellSnapshot: true,
      connectionState: "reconnecting",
      connectionError: "Could not reach sleeping laptop",
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "MacBook",
          displayUrl: "",
          isRelayManaged: false,
          isEnabled: true,
          connectionState: "connecting",
          connectionError: null,
          connectionErrorTraceId: null,
        },
        {
          environmentId: "environment-2" as never,
          environmentLabel: "Sleeping laptop",
          displayUrl: "",
          isRelayManaged: false,
          isEnabled: true,
          connectionState: "reconnecting",
          connectionError: "Could not reach sleeping laptop",
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Updating...",
      showsProgress: true,
    });
  });

  it("names only the hopeful environment when reconnecting without a cache", () => {
    const state = workspaceState({
      hasReadyEnvironment: false,
      hasConnectingEnvironment: true,
      hasLoadedShellSnapshot: false,
      connectionState: "reconnecting",
      connectionError: "Could not reach sleeping laptop",
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "MacBook",
          displayUrl: "",
          isRelayManaged: false,
          isEnabled: true,
          connectionState: "connecting",
          connectionError: null,
          connectionErrorTraceId: null,
        },
        {
          environmentId: "environment-2" as never,
          environmentLabel: "Sleeping laptop",
          displayUrl: "",
          isRelayManaged: false,
          isEnabled: true,
          connectionState: "reconnecting",
          connectionError: "Could not reach sleeping laptop",
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Reconnecting to MacBook",
      showsProgress: true,
    });
  });
});
