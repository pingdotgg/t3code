import { describe, expect, it } from "vite-plus/test";

import {
  deriveProjectHostControlAvailability,
  PROJECT_HOST_ACTION_UNAVAILABLE_REASON,
  PROJECT_HOST_PROJECT_UNAVAILABLE_REASON,
  PROJECT_HOST_TERMINAL_UNAVAILABLE_REASON,
} from "./projectHostControls";

describe("deriveProjectHostControlAvailability", () => {
  it("enables terminal and project action controls for a connected active project host", () => {
    expect(
      deriveProjectHostControlAvailability({
        hasActiveProject: true,
        environmentConnectionPhase: "connected",
        terminalDrawerOpen: false,
      }),
    ).toEqual({
      terminalControlsAvailable: true,
      terminalDrawerToggleAvailable: true,
      projectActionsRunAvailable: true,
      terminalControlsUnavailableReason: null,
      terminalDrawerToggleUnavailableReason: null,
      projectActionsRunUnavailableReason: null,
    });
  });

  it("keeps all controls available when a connected active project has an open terminal drawer", () => {
    expect(
      deriveProjectHostControlAvailability({
        hasActiveProject: true,
        environmentConnectionPhase: "connected",
        terminalDrawerOpen: true,
      }),
    ).toEqual({
      terminalControlsAvailable: true,
      terminalDrawerToggleAvailable: true,
      projectActionsRunAvailable: true,
      terminalControlsUnavailableReason: null,
      terminalDrawerToggleUnavailableReason: null,
      projectActionsRunUnavailableReason: null,
    });
  });

  it("requires both an active project and a connected project host", () => {
    expect(
      deriveProjectHostControlAvailability({
        hasActiveProject: false,
        environmentConnectionPhase: "connected",
        terminalDrawerOpen: false,
      }),
    ).toEqual({
      terminalControlsAvailable: false,
      terminalDrawerToggleAvailable: false,
      projectActionsRunAvailable: false,
      terminalControlsUnavailableReason: PROJECT_HOST_PROJECT_UNAVAILABLE_REASON,
      terminalDrawerToggleUnavailableReason: PROJECT_HOST_PROJECT_UNAVAILABLE_REASON,
      projectActionsRunUnavailableReason: PROJECT_HOST_PROJECT_UNAVAILABLE_REASON,
    });

    for (const environmentConnectionPhase of [
      "available",
      "offline",
      "connecting",
      "reconnecting",
      "error",
      null,
    ] as const) {
      expect(
        deriveProjectHostControlAvailability({
          hasActiveProject: true,
          environmentConnectionPhase,
          terminalDrawerOpen: false,
        }),
      ).toEqual({
        terminalControlsAvailable: false,
        terminalDrawerToggleAvailable: false,
        projectActionsRunAvailable: false,
        terminalControlsUnavailableReason: PROJECT_HOST_TERMINAL_UNAVAILABLE_REASON,
        terminalDrawerToggleUnavailableReason: PROJECT_HOST_TERMINAL_UNAVAILABLE_REASON,
        projectActionsRunUnavailableReason: PROJECT_HOST_ACTION_UNAVAILABLE_REASON,
      });
    }
  });

  it("keeps the terminal drawer toggle available while an existing drawer is open", () => {
    expect(
      deriveProjectHostControlAvailability({
        hasActiveProject: false,
        environmentConnectionPhase: null,
        terminalDrawerOpen: true,
      }),
    ).toEqual({
      terminalControlsAvailable: false,
      terminalDrawerToggleAvailable: true,
      projectActionsRunAvailable: false,
      terminalControlsUnavailableReason: PROJECT_HOST_PROJECT_UNAVAILABLE_REASON,
      terminalDrawerToggleUnavailableReason: null,
      projectActionsRunUnavailableReason: PROJECT_HOST_PROJECT_UNAVAILABLE_REASON,
    });

    expect(
      deriveProjectHostControlAvailability({
        hasActiveProject: true,
        environmentConnectionPhase: "reconnecting",
        terminalDrawerOpen: true,
      }),
    ).toEqual({
      terminalControlsAvailable: false,
      terminalDrawerToggleAvailable: true,
      projectActionsRunAvailable: false,
      terminalControlsUnavailableReason: PROJECT_HOST_TERMINAL_UNAVAILABLE_REASON,
      terminalDrawerToggleUnavailableReason: null,
      projectActionsRunUnavailableReason: PROJECT_HOST_ACTION_UNAVAILABLE_REASON,
    });
  });
});
