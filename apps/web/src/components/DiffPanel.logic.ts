import type { TurnId } from "@t3tools/contracts";

import { type DiffSurfaceFocus } from "../workspace/types";

export function normalizeDiffSurfaceFocus(
  focus: DiffSurfaceFocus,
  availableTurnIds: readonly TurnId[],
): DiffSurfaceFocus {
  if (focus.scope !== "turn") {
    return focus;
  }

  // Preserve explicit turn deep links until we have at least one summary to validate against.
  if (availableTurnIds.length === 0 || availableTurnIds.includes(focus.turnId)) {
    return focus;
  }

  return { scope: "conversation" };
}
