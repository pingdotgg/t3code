import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import { deriveHomeEmptyState } from "./home-empty-state";

function connectingEnvironment(
  connectionState: "connecting" | "reconnecting",
  connectionError: string | null,
): WorkspaceEnvironment {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    environmentLabel: "corex",
    displayUrl: "",
    isRelayManaged: false,
    isEnabled: true,
    connectionState,
    connectionError,
    connectionErrorTraceId: null,
  };
}

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

const RETAINED_FAILURE = "Environment did not respond before the connection timeout.";
const reconnecting = connectingEnvironment("reconnecting", RETAINED_FAILURE);

describe("home empty state", () => {
  it.each([
    [
      "waits while a saved environment retries after a retained failure",
      workspaceState({
        hasLoadedShellSnapshot: false,
        hasPendingShellSnapshot: true,
        hasReadyEnvironment: false,
        hasConnectingEnvironment: true,
        connectingEnvironments: [reconnecting],
        connectionState: "reconnecting",
        connectionError: RETAINED_FAILURE,
      }),
      1,
      { title: "Connecting to environment", loading: true, showsAddEnvironment: false },
    ],
    [
      "waits for a connected environment's first shell snapshot",
      workspaceState({
        hasLoadedShellSnapshot: false,
        hasPendingShellSnapshot: true,
        hasSyncingConnectedEnvironment: true,
      }),
      0,
      { title: "Loading threads", loading: true, showsAddEnvironment: false },
    ],
    [
      "waits while another environment is still connecting after one loaded empty",
      workspaceState({
        hasPendingShellSnapshot: true,
        hasConnectingEnvironment: true,
        connectingEnvironments: [reconnecting],
        connectionError: RETAINED_FAILURE,
      }),
      0,
      { title: "Loading threads", loading: true, showsAddEnvironment: false },
    ],
    [
      "reports no threads once every environment has resolved",
      workspaceState(),
      1,
      { title: "No threads yet", loading: false, showsAddEnvironment: false },
    ],
    [
      "reports no projects once every environment has resolved",
      workspaceState(),
      0,
      { title: "No projects found", loading: false, showsAddEnvironment: false },
    ],
    [
      "reports an unavailable environment without a snapshot",
      workspaceState({
        hasLoadedShellSnapshot: false,
        hasReadyEnvironment: false,
        connectionState: "error",
        connectionError: "Connection failed.",
      }),
      0,
      { title: "Environment unavailable", loading: false, showsAddEnvironment: true },
    ],
    [
      "reports an unsupported client without a snapshot",
      workspaceState({
        hasLoadedShellSnapshot: false,
        hasReadyEnvironment: false,
        connectionState: "unsupported",
        connectionError: "Update the app.",
      }),
      0,
      { title: "Client not supported", loading: false, showsAddEnvironment: true },
    ],
    [
      "does not wait on retries while the device is offline",
      workspaceState({
        hasPendingShellSnapshot: true,
        hasReadyEnvironment: false,
        hasConnectingEnvironment: true,
        connectingEnvironments: [reconnecting],
        connectionState: "offline",
        networkStatus: "offline",
      }),
      1,
      { title: "No threads yet", loading: false, showsAddEnvironment: true },
    ],
    [
      "offers to add an environment when none are saved",
      workspaceState({
        hasConnections: false,
        hasLoadedShellSnapshot: false,
        hasReadyEnvironment: false,
        connectionState: "available",
      }),
      0,
      { title: "No environments connected", loading: false, showsAddEnvironment: true },
    ],
  ] as const)("%s", (_name, state, projectCount, expected) => {
    const { title, loading, showsAddEnvironment } = deriveHomeEmptyState(state, projectCount);
    expect({ title, loading, showsAddEnvironment }).toEqual(expected);
  });
});
