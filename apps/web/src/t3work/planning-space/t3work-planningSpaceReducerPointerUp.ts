/**
 * The `pointerUp` branch of the planning interaction reducer — drag releases
 * (person→item assign) and click resolution (assign mode, epic framing, owner
 * spotlight toggle, detail open, background clear). Split out of
 * t3work-planningSpaceReducer.ts to keep each module under the LOC budget.
 */

import type {
  InteractionState,
  PlanningEvent,
  PlanningIntent,
  ReduceResult,
} from "./t3work-planningSpaceInteractions";
import { groupOf, itemOf } from "./t3work-planningSpaceReducerHelpers";

type PointerUpEvent = Extract<PlanningEvent, { type: "pointerUp" }>;

export function reducePlanningPointerUp(
  state: InteractionState,
  event: PointerUpEvent,
): ReduceResult {
  const pointer = state.pointer;
  if (!pointer) return { state, intents: [] };
  const cleared: InteractionState = { ...state, pointer: null, dragging: null };

  // Drag releases.
  if (pointer.moved && state.dragging) {
    if (state.dragging.kind === "person") {
      const intents: PlanningIntent[] = [{ type: "personDragEnd" }];
      const item = itemOf(event.hit);
      if (item) {
        intents.push({ type: "assign", item, ownerId: state.dragging.ownerId });
      }
      return { state: cleared, intents };
    }
    return { state: cleared, intents: [] };
  }

  // Clicks (no movement).
  const hit = pointer.downHit;
  if (hit.type === "ownerAffordance") {
    return {
      state: { ...cleared, assignTarget: hit.item },
      intents: [{ type: "assignModeStart", item: hit.item }],
    };
  }
  const group = groupOf(hit);
  if (group) {
    if (state.assignTarget && group.kind === "owner") {
      const item = state.assignTarget;
      return {
        state: { ...cleared, assignTarget: null },
        intents: [
          { type: "assign", item, ownerId: group.ownerId },
          { type: "assignModeEnd" },
        ],
      };
    }
    // Epics are places: clicking one flies into its cluster (stories +
    // subtasks). Owner anchors spotlight their member's work.
    if (group.kind === "epic") {
      return { state: cleared, intents: [{ type: "frameGroup", group }] };
    }
    const togglesOff =
      state.spotlight !== null && JSON.stringify(state.spotlight) === JSON.stringify(group);
    return {
      state: { ...cleared, spotlight: togglesOff ? null : group },
      intents: [{ type: "spotlightToggle", group }],
    };
  }
  const item = itemOf(hit);
  if (item) {
    const band = hit.type === "frame" || hit.type === "subtask" ? hit.band : 0;
    if (band >= 5) return { state: cleared, intents: [] };
    return {
      state: { ...cleared, detail: item },
      intents: [{ type: "openDetail", item }],
    };
  }
  // Background click: close detail, cancel assign mode.
  const intents: PlanningIntent[] = [];
  if (state.detail) intents.push({ type: "closeDetail" });
  if (state.assignTarget) intents.push({ type: "assignModeEnd" });
  return { state: { ...cleared, detail: null, assignTarget: null }, intents };
}
