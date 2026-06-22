import type { SessionPhase } from "../../types";

export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

/** One policy seam for the future configurable active-turn default action. */
export function resolveComposerDispatchMode(input: {
  readonly phase: SessionPhase;
  readonly queueModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
}): ComposerDispatchMode {
  if (input.phase !== "running") return "auto";
  if (input.queueModifier) return "queue";
  return input.activeTurnDefault ?? "steer";
}
