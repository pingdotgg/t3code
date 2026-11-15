import {
  type ClientRect,
  type Collision,
  type CollisionDetection,
  type DroppableContainer,
  pointerWithin,
} from "@dnd-kit/core";

import {
  paneOf,
  type PaneSide,
  type PanelArrangement,
  type SplitChange,
} from "./splitLayout.logic";

export interface ContentDropData {
  readonly kind: "content";
  readonly pane: PaneSide;
}

export type DropOver =
  | { readonly kind: "tab"; readonly id: string; readonly rect: ClientRect }
  | { readonly kind: "content"; readonly pane: PaneSide; readonly rect: ClientRect };

/** Viewport coordinates. A box previews the new pane or the receiving pane; a marker is a slot. */
export type DropGhost =
  | {
      readonly kind: "box";
      readonly left: number;
      readonly top: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "marker";
      readonly left: number;
      readonly top: number;
      readonly height: number;
    };

export interface DropPlan {
  readonly change: SplitChange;
  /** Null for a reorder in the tab's own strip, where the strip's live shift shows the slot. */
  readonly ghost: DropGhost | null;
}

export interface DropInput {
  /** The live store state, so a tab opened or closed mid-drag cannot mislead the plan. */
  readonly arrangement: PanelArrangement;
  /** Two strips are on screen. */
  readonly splitRendered: boolean;
  readonly splitAllowed: boolean;
  readonly draggedId: string;
  readonly over: DropOver | null;
  readonly pointer: { readonly x: number; readonly y: number } | null;
  /** What the dragged tab's pane showed before the press activated the tab. */
  readonly restoreShown: string | null;
  /** How far a new split widens the panel (it grows to the left), so the ghost shows the result. */
  readonly splitGrowth: number;
}

const MARKER_WIDTH = 2;

function restore(restoreShown: string | null): { restoreShown?: string } {
  return restoreShown === null ? {} : { restoreShown };
}

function sameStripReorder(input: DropInput, overId: string): SplitChange | null {
  const { arrangement, draggedId } = input;
  const strip = input.splitRendered
    ? arrangement.surfaces.filter(
        (surface) => paneOf(arrangement, surface.id) === paneOf(arrangement, draggedId),
      )
    : arrangement.surfaces;
  const from = strip.findIndex((surface) => surface.id === draggedId);
  const to = strip.findIndex((surface) => surface.id === overId);
  if (from < 0 || to < 0 || from === to) return null;
  const order = strip.map((surface) => surface.id);
  order.splice(to, 0, ...order.splice(from, 1));
  const beforeId = order[to + 1] ?? null;
  const pane = paneOf(arrangement, overId);
  if (pane !== paneOf(arrangement, draggedId)) {
    return { type: "move", surfaceId: draggedId, pane, beforeId, ...restore(input.restoreShown) };
  }
  return {
    type: "reorder",
    surfaceId: draggedId,
    beforeId: beforeId !== null && paneOf(arrangement, beforeId) === pane ? beforeId : null,
  };
}

/**
 * What a drop at the current pointer would do. Same strip: reorder. Other strip: the half of
 * the tab under the pointer picks the slot. One pane's content: the outer thirds split to that
 * side (the centre does nothing). Split content: the other pane takes the tab at its end.
 * A plan that would change nothing is null, so no ghost promises it.
 */
export function resolveDrop(input: DropInput): DropPlan | null {
  const { arrangement, draggedId, over, pointer } = input;
  if (over === null || pointer === null) return null;
  if (!arrangement.surfaces.some((surface) => surface.id === draggedId)) return null;
  const draggedPane = paneOf(arrangement, draggedId);

  if (over.kind === "tab") {
    if (!arrangement.surfaces.some((surface) => surface.id === over.id)) return null;
    const overPane = paneOf(arrangement, over.id);
    if (!input.splitRendered || overPane === draggedPane) {
      const change = sameStripReorder(input, over.id);
      return change === null ? null : { change, ghost: null };
    }
    const after = pointer.x >= over.rect.left + over.rect.width / 2;
    const strip = arrangement.surfaces.filter(
      (surface) => paneOf(arrangement, surface.id) === overPane,
    );
    const index = strip.findIndex((surface) => surface.id === over.id);
    const beforeId = after ? (strip[index + 1]?.id ?? null) : over.id;
    return {
      change: {
        type: "move",
        surfaceId: draggedId,
        pane: overPane,
        beforeId,
        ...restore(input.restoreShown),
      },
      ghost: {
        kind: "marker",
        left: (after ? over.rect.right : over.rect.left) - MARKER_WIDTH / 2,
        top: over.rect.top,
        height: over.rect.height,
      },
    };
  }

  const { rect } = over;
  if (!input.splitRendered) {
    if (!input.splitAllowed || arrangement.split !== undefined) return null;
    if (arrangement.surfaces.length < 2) return null;
    const third = rect.width / 3;
    const side: PaneSide | null =
      pointer.x < rect.left + third ? "left" : pointer.x > rect.right - third ? "right" : null;
    if (side === null) return null;
    const grownLeft = rect.left - input.splitGrowth;
    const half = (rect.right - grownLeft) / 2;
    return {
      change: { type: "split", surfaceId: draggedId, side, ...restore(input.restoreShown) },
      ghost: {
        kind: "box",
        left: side === "left" ? grownLeft : grownLeft + half,
        top: rect.top,
        width: half,
        height: rect.height,
      },
    };
  }
  if (over.pane === draggedPane) return null;
  return {
    change: {
      type: "move",
      surfaceId: draggedId,
      pane: over.pane,
      beforeId: null,
      ...restore(input.restoreShown),
    },
    ghost: { kind: "box", left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  };
}

export function samePlan(left: DropPlan | null, right: DropPlan | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A pointer this far above or below a strip's tabs, but over its pane, still aims at the strip. */
const STRIP_SLOP = 8;

type DropData =
  | { readonly kind: "tab"; readonly pane: PaneSide | null }
  | ContentDropData
  | undefined;

function dataOf(container: DroppableContainer): DropData {
  return container.data.current as DropData;
}

function contains(rect: ClientRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function collision(container: DroppableContainer, value: number): Collision {
  return { id: container.id, data: { droppableContainer: container, value } };
}

/**
 * A tab under the pointer wins. A pointer in a strip's row but between tabs aims at the
 * strip's nearest tab. Then the pane content under the pointer. Else nothing.
 * Tabs count only over their own pane, since a scrolled-out tab keeps a rect past its strip.
 */
export const panelCollision: CollisionDetection = (args) => {
  const pointer = args.pointerCoordinates;
  if (pointer === null) return [];
  const rectOf = (container: DroppableContainer) => args.droppableRects.get(container.id);
  const content = args.droppableContainers.find((container) => {
    const data = dataOf(container);
    const rect = rectOf(container);
    return data?.kind === "content" && rect && pointer.x >= rect.left && pointer.x <= rect.right;
  });
  if (content === undefined) return [];
  const pane = (dataOf(content) as ContentDropData).pane;
  const tabs = args.droppableContainers.filter((container) => {
    const data = dataOf(container);
    return data?.kind === "tab" && rectOf(container) && (data.pane ?? "left") === pane;
  });

  const hit = pointerWithin(args).find((entry) =>
    tabs.some((container) => container.id === entry.id),
  );
  if (hit) return [hit];

  if (tabs.length > 0) {
    const rects = tabs.map((container) => rectOf(container)!);
    const top = Math.min(...rects.map((rect) => rect.top)) - STRIP_SLOP;
    const bottom = Math.max(...rects.map((rect) => rect.bottom)) + STRIP_SLOP;
    if (pointer.y >= top && pointer.y <= bottom) {
      let nearest = 0;
      let distance = Infinity;
      rects.forEach((rect, index) => {
        const gap = Math.abs(pointer.x - (rect.left + rect.width / 2));
        if (gap < distance) {
          distance = gap;
          nearest = index;
        }
      });
      return [collision(tabs[nearest]!, distance)];
    }
  }

  const contentRect = rectOf(content);
  return contentRect && contains(contentRect, pointer.x, pointer.y) ? [collision(content, 0)] : [];
};
