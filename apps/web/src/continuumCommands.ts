import {
  CONTINUUM_COMMANDS,
  type ContinuumCommandName,
  type ContinuumPanel,
} from "@t3tools/shared/continuumCommands";

import type { RightPanelKind } from "./rightPanelStore";

/**
 * Commands this composer can run. Skills only need a turn, so drafts offer them too; actions such
 * as `/improve` act on an existing thread.
 */
export function availableContinuumCommands(input: {
  readonly serverThread: boolean;
}): ReadonlySet<ContinuumCommandName> {
  return new Set(
    CONTINUUM_COMMANDS.filter((spec) => spec.kind === "skill" || input.serverThread).map(
      (spec) => spec.name,
    ),
  );
}

export const CONTINUUM_PANEL_SURFACES = {
  forge: "forge",
  "agent-eyes": "agent-eyes",
  "time-machine": null,
  swarm: null,
  preview: null,
} as const satisfies Record<ContinuumPanel, RightPanelKind | null>;
