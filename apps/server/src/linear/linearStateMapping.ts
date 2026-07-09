import type { LinearTeamStateMapping, LinearWorkflowState } from "@t3tools/contracts";

export type LinearLifecycleStage = "started" | "review" | "done";

/**
 * Resolve which Linear workflow-state id a lifecycle stage should move an issue
 * to, for a given team. Precedence:
 *   1. explicit per-team override (if it still exists in the team's states);
 *   2. a sensibly-named state ("In Progress" / "In Review");
 *   3. the first state of the matching category `type`.
 * Returns undefined when nothing sensible maps (the caller skips the transition).
 */
export function resolveTargetStateId(
  states: ReadonlyArray<LinearWorkflowState>,
  mapping: LinearTeamStateMapping | undefined,
  stage: LinearLifecycleStage,
): string | undefined {
  const override = mapping?.[stage];
  if (override !== undefined && states.some((state) => state.id === override)) {
    return override;
  }

  const ordered = [...states].sort((a, b) => a.position - b.position);
  const byType = (type: LinearWorkflowState["type"]) =>
    ordered.find((state) => state.type === type)?.id;
  const byName = (needle: string) =>
    ordered.find((state) => state.name.toLowerCase().includes(needle))?.id;

  switch (stage) {
    case "started":
      return byName("in progress") ?? byType("started");
    case "review":
      // Linear has no "review" category; teams model it as a custom started
      // state (commonly "In Review"). Fall back to nothing so the caller skips.
      return byName("in review") ?? byName("review");
    case "done":
      return byType("completed");
  }
}
