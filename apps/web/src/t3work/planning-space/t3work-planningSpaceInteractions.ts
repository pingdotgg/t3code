/**
 * Planning space interaction state machine — the spec §6 contract as code.
 *
 * Pure reducer: `(state, event) → { state, intents }`. The view feeds it
 * pointer/key events with abstract hit descriptions and applies the returned
 * intents (assign, pan, open detail, spotlight…). One primitive per concept,
 * every surface — divergence is structurally impossible because all surfaces
 * route through this module.
 */

export type PlanningItemRef =
  | { readonly kind: "story"; readonly storyId: string }
  | {
      readonly kind: "subtask";
      readonly storyId: string;
      readonly subtaskId: string;
    };

export type PlanningHit =
  | { readonly type: "frame"; readonly storyId: string; readonly band: number }
  | {
      readonly type: "subtask";
      readonly storyId: string;
      readonly subtaskId: string;
      readonly band: number;
    }
  | { readonly type: "ownerAffordance"; readonly item: PlanningItemRef }
  | { readonly type: "dock"; readonly ownerId: string | null }
  | { readonly type: "ownerHeader"; readonly ownerId: string | null }
  | { readonly type: "epicAnchor"; readonly epicId: string }
  | { readonly type: "epicTile"; readonly epicId: string }
  | { readonly type: "background" };

export interface DropContext {
  readonly grouping: "epic" | "sprint" | "owner";
  /** World x separating the sprint zone (negative side) from outside. */
  readonly sprintBoundaryX: number;
  readonly ownerClusters: ReadonlyArray<{
    readonly ownerId: string | null;
    readonly x: number;
    readonly y: number;
  }>;
}

export type PlanningEvent =
  | {
      readonly type: "pointerDown";
      readonly hit: PlanningHit;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "pointerMove";
      readonly x: number;
      readonly y: number;
      readonly worldX: number;
      readonly worldY: number;
    }
  | {
      readonly type: "pointerUp";
      readonly hit: PlanningHit;
      readonly worldX: number;
      readonly worldY: number;
      readonly drop: DropContext;
    }
  | { readonly type: "doubleClick"; readonly hit: PlanningHit }
  | { readonly type: "escape" };

export type PlanningIntent =
  | {
      readonly type: "assign";
      readonly item: PlanningItemRef;
      readonly ownerId: string | null;
    }
  | {
      readonly type: "setSprintMembership";
      readonly storyId: string;
      readonly inSprint: boolean;
    }
  | {
      readonly type: "reparent";
      readonly storyId: string;
      readonly epicId: string;
    }
  | { readonly type: "panBy"; readonly dx: number; readonly dy: number }
  | { readonly type: "personDragStart"; readonly ownerId: string | null }
  | { readonly type: "personDragEnd" }
  | { readonly type: "openDetail"; readonly item: PlanningItemRef }
  | { readonly type: "closeDetail" }
  | { readonly type: "assignModeStart"; readonly item: PlanningItemRef }
  | { readonly type: "assignModeEnd" }
  | {
      readonly type: "spotlightToggle";
      readonly group:
        | { readonly kind: "owner"; readonly ownerId: string | null }
        | { readonly kind: "epic"; readonly epicId: string };
    }
  | { readonly type: "spotlightClear" }
  | {
      readonly type: "frameGroup";
      readonly group:
        | { readonly kind: "owner"; readonly ownerId: string | null }
        | { readonly kind: "epic"; readonly epicId: string };
    }
  | { readonly type: "frameItem"; readonly item: PlanningItemRef };

export const DRAG_THRESHOLD_PX = 5;

interface PointerSession {
  readonly downHit: PlanningHit;
  readonly downX: number;
  readonly downY: number;
  moved: boolean;
}

export interface InteractionState {
  readonly pointer: PointerSession | null;
  readonly dragging:
    | { readonly kind: "person"; readonly ownerId: string | null }
    | { readonly kind: "pan" }
    | null;
  readonly assignTarget: PlanningItemRef | null;
  readonly detail: PlanningItemRef | null;
  readonly spotlight:
    | { readonly kind: "owner"; readonly ownerId: string | null }
    | { readonly kind: "epic"; readonly epicId: string }
    | null;
}

export const initialInteractionState: InteractionState = {
  pointer: null,
  dragging: null,
  assignTarget: null,
  detail: null,
  spotlight: null,
};

export interface ReduceResult {
  readonly state: InteractionState;
  readonly intents: ReadonlyArray<PlanningIntent>;
}


export { reducePlanningEvent } from "./t3work-planningSpaceReducer";
