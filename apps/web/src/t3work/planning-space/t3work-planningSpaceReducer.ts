/**
 * The planning-space interaction reducer — a pure state machine turning pointer/
 * keyboard events into next-state + intents (drag vs pan, assign mode, spotlight,
 * detail, the §6.7 Escape ladder). The `pointerUp` branch lives in
 * t3work-planningSpaceReducerPointerUp.ts; shared mappers in
 * t3work-planningSpaceReducerHelpers.ts. Split out of
 * t3work-planningSpaceInteractions.ts.
 */

import {
  DRAG_THRESHOLD_PX,
  type PlanningEvent,
  type InteractionState,
  type ReduceResult,
} from "./t3work-planningSpaceInteractions";
import { groupOf, itemOf } from "./t3work-planningSpaceReducerHelpers";
import { reducePlanningPointerUp } from "./t3work-planningSpaceReducerPointerUp";

export function reducePlanningEvent(
  state: InteractionState,
  event: PlanningEvent,
): ReduceResult {
  switch (event.type) {
    case "pointerDown": {
      return {
        state: {
          ...state,
          pointer: { downHit: event.hit, downX: event.x, downY: event.y, moved: false },
        },
        intents: [],
      };
    }

    case "pointerMove": {
      const pointer = state.pointer;
      if (!pointer) return { state, intents: [] };
      const moved =
        pointer.moved ||
        Math.abs(event.x - pointer.downX) + Math.abs(event.y - pointer.downY) > DRAG_THRESHOLD_PX;
      if (!moved) return { state, intents: [] };

      if (state.dragging === null) {
        const hit = pointer.downHit;
        // Items are NOT draggable (PJ: node-dragging made navigation finicky)
        // — starting a gesture on a card pans like anywhere else. Assignment
        // runs through assign mode and person→item drags only.
        const group = groupOf(hit);
        if (group && group.kind === "owner") {
          return {
            state: {
              ...state,
              pointer: { ...pointer, moved: true },
              dragging: { kind: "person", ownerId: group.ownerId },
            },
            intents: [{ type: "personDragStart", ownerId: group.ownerId }],
          };
        }
        return {
          state: { ...state, pointer: { ...pointer, moved: true }, dragging: { kind: "pan" } },
          intents: [{ type: "panBy", dx: event.x - pointer.downX, dy: event.y - pointer.downY }],
        };
      }

      if (state.dragging.kind === "pan") {
        return {
          state: { ...state, pointer: { ...pointer, moved: true } },
          intents: [{ type: "panBy", dx: event.x - pointer.downX, dy: event.y - pointer.downY }],
        };
      }
      return { state: { ...state, pointer: { ...pointer, moved: true } }, intents: [] };
    }

    case "pointerUp":
      return reducePlanningPointerUp(state, event);

    case "doubleClick": {
      const group = groupOf(event.hit);
      if (group) return { state, intents: [{ type: "frameGroup", group }] };
      // Quick zoom (§3.1 UX): double-click an item to dive onto it; the view
      // toggles back out on a second double-click.
      const item = itemOf(event.hit);
      if (item) return { state, intents: [{ type: "frameItem", item }] };
      return { state, intents: [] };
    }

    case "escape": {
      // §6.7 ladder: cancel drag → close detail → cancel assign → clear spotlight.
      if (state.dragging && state.dragging.kind === "person") {
        return {
          state: { ...state, dragging: null, pointer: null },
          intents: [{ type: "personDragEnd" }],
        };
      }
      if (state.detail) {
        return { state: { ...state, detail: null }, intents: [{ type: "closeDetail" }] };
      }
      if (state.assignTarget) {
        return { state: { ...state, assignTarget: null }, intents: [{ type: "assignModeEnd" }] };
      }
      if (state.spotlight) {
        return { state: { ...state, spotlight: null }, intents: [{ type: "spotlightClear" }] };
      }
      return { state, intents: [] };
    }
  }
}
