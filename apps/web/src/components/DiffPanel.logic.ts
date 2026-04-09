import type { TurnId } from "@t3tools/contracts";

import { type DiffSurfaceFocus } from "../workspace/types";

export function normalizeDiffSurfaceFocus(
  focus: DiffSurfaceFocus,
  availableTurnIds: readonly TurnId[],
): DiffSurfaceFocus {
  if (focus.scope !== "turn") {
    return focus;
  }

  if (availableTurnIds.includes(focus.turnId)) {
    return focus;
  }

  return { scope: "conversation" };
}
