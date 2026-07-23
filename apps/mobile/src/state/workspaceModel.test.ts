import type { EnvironmentShellSummary } from "@t3tools/client-runtime/state/shell";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { projectWorkspaceEnvironment, projectWorkspaceState } from "./workspaceModel";
import type { EnvironmentPresentation } from "./environments";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function environment(
  phase: EnvironmentPresentation["connection"]["phase"],
): EnvironmentPresentation {
  const connectionId = `bearer:${ENVIRONMENT_ID}`;
  return {
    environmentId: ENVIRONMENT_ID,
    label: "Julius's MacBook Pro",
    displayUrl: "https://environment.example.test",
    relayManaged: false,
    entry: {
      target: new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Julius's MacBook Pro",
        connectionId,
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId,
          environmentId: ENVIRONMENT_ID,
          label: "Julius's MacBook Pro",
          httpBaseUrl: "https://environment.example.test",
          wsBaseUrl: "wss://environment.example.test",
        }),
      ),
    },
    connection: {
      phase,
      error: phase === "error" ? "Connection failed." : null,
      traceId: phase === "error" ? "trace-1" : null,
    },
    serverConfig: null,
  };
}

const EMPTY_SHELL_SUMMARY: EnvironmentShellSummary = {
  hasSnapshot: false,
  hasSynchronizingShell: false,
  hasCachedShell: false,
  hasLiveShell: false,
  firstError: null,
  latestSnapshotUpdatedAt: null,
};

const CACHED_SHELL_SUMMARY: EnvironmentShellSummary = {
  ...EMPTY_SHELL_SUMMARY,
  hasSnapshot: true,
  hasSynchronizingShell: true,
  hasCachedShell: true,
  latestSnapshotUpdatedAt: "2026-06-07T00:00:00.000Z",
};

describe("mobile workspace projection", () => {
  it("preserves explicit offline state without presenting it as a connection error", () => {
    const projected = projectWorkspaceEnvironment(environment("offline"));

    expect(projected.connectionState).toBe("offline");
    expect(projected.connectionError).toBeNull();
  });

  it("reports offline before stale connected presentations", () => {
    const environments = [projectWorkspaceEnvironment(environment("connected"))];
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "offline",
      environments,
      shellSummary: EMPTY_SHELL_SUMMARY,
    });

    expect(state.connectionState).toBe("offline");
    expect(state.networkStatus).toBe("offline");
    expect(state.hasReadyEnvironment).toBe(false);
  });

  it("projects reconnecting environments dynamically from active phases", () => {
    const environments = [
      projectWorkspaceEnvironment(environment("reconnecting")),
      projectWorkspaceEnvironment({
        ...environment("connected"),
        environmentId: EnvironmentId.make("environment-2"),
      }),
    ];
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "online",
      environments,
      shellSummary: EMPTY_SHELL_SUMMARY,
    });

    expect(state.connectingEnvironments).toHaveLength(1);
    expect(state.connectingEnvironments[0]?.connectionState).toBe("reconnecting");
    expect(state.hasConnectingEnvironment).toBe(true);
    expect(state.hasReadyEnvironment).toBe(true);
  });

  it("keeps retained snapshots visible while reconnecting without claiming readiness", () => {
    const environments = [projectWorkspaceEnvironment(environment("reconnecting"))];
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "online",
      environments,
      shellSummary: CACHED_SHELL_SUMMARY,
    });

    expect(state.hasLoadedShellSnapshot).toBe(true);
    expect(state.hasPendingShellSnapshot).toBe(true);
    expect(state.hasReadyEnvironment).toBe(false);
    expect(state.connectionState).toBe("reconnecting");
  });
});
