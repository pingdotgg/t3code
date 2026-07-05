import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

export const PROJECT_HOST_TERMINAL_UNAVAILABLE_REASON =
  "Connect the project host to use terminals.";
export const PROJECT_HOST_ACTION_UNAVAILABLE_REASON = "Connect the project host to run actions.";
export const PROJECT_HOST_PROJECT_UNAVAILABLE_REASON =
  "Open a project to use project host controls.";

export interface ProjectHostControlAvailability {
  readonly terminalControlsAvailable: boolean;
  readonly terminalDrawerToggleAvailable: boolean;
  readonly projectActionsRunAvailable: boolean;
  readonly terminalControlsUnavailableReason: string | null;
  readonly terminalDrawerToggleUnavailableReason: string | null;
  readonly projectActionsRunUnavailableReason: string | null;
}

/**
 * Centralizes host-gated controls so project actions and terminal creation stay
 * disabled unless a project is open and its host is connected. An open terminal
 * drawer remains toggleable so stale terminal surfaces can still be closed.
 */
export function deriveProjectHostControlAvailability(input: {
  readonly hasActiveProject: boolean;
  readonly environmentConnectionPhase: EnvironmentConnectionPhase | null;
  readonly terminalDrawerOpen: boolean;
}): ProjectHostControlAvailability {
  const connectedProjectHost =
    input.hasActiveProject && input.environmentConnectionPhase === "connected";
  const unavailableReason = input.hasActiveProject
    ? PROJECT_HOST_TERMINAL_UNAVAILABLE_REASON
    : PROJECT_HOST_PROJECT_UNAVAILABLE_REASON;
  const terminalDrawerToggleAvailable = connectedProjectHost || input.terminalDrawerOpen;

  return {
    terminalControlsAvailable: connectedProjectHost,
    terminalDrawerToggleAvailable,
    projectActionsRunAvailable: connectedProjectHost,
    terminalControlsUnavailableReason: connectedProjectHost ? null : unavailableReason,
    terminalDrawerToggleUnavailableReason: terminalDrawerToggleAvailable ? null : unavailableReason,
    projectActionsRunUnavailableReason: connectedProjectHost
      ? null
      : input.hasActiveProject
        ? PROJECT_HOST_ACTION_UNAVAILABLE_REASON
        : PROJECT_HOST_PROJECT_UNAVAILABLE_REASON,
  };
}
