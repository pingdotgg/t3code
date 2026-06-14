/**
 * Shared hit→ref/group mappers for the planning interaction reducer. Split out
 * of t3work-planningSpaceInteractions.ts / t3work-planningSpaceReducer.ts.
 */

import type { PlanningHit, PlanningItemRef } from "./t3work-planningSpaceInteractions";

export function itemOf(hit: PlanningHit): PlanningItemRef | null {
  if (hit.type === "frame") return { kind: "story", storyId: hit.storyId };
  if (hit.type === "subtask") {
    return { kind: "subtask", storyId: hit.storyId, subtaskId: hit.subtaskId };
  }
  return null;
}

export function groupOf(
  hit: PlanningHit,
):
  | { readonly kind: "owner"; readonly ownerId: string | null }
  | { readonly kind: "epic"; readonly epicId: string }
  | null {
  if (hit.type === "dock" || hit.type === "ownerHeader") {
    return { kind: "owner", ownerId: hit.ownerId };
  }
  if (hit.type === "epicAnchor" || hit.type === "epicTile") {
    return { kind: "epic", epicId: hit.epicId };
  }
  return null;
}
