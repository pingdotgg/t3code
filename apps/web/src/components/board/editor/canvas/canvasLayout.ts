import type { WorkflowDefinitionEncoded } from "@t3tools/contracts";

import {
  classifyEdge,
  clearBottomForSpan,
  packDetourLanes,
  type DetourSpan,
  type EdgeRect,
} from "./edgeRouting";

export { LANE_CARD_WIDTH, LANE_GAP_X, LANE_GAP_Y } from "./edgeRouting";
import { LANE_CARD_WIDTH, LANE_GAP_X, LANE_GAP_Y } from "./edgeRouting";

const LANE_BASE_HEIGHT = 132;
const STEP_BLOCK_HEIGHT = 58;
// Slack reserved below the deepest local-detour track for its stroke and any
// label pill that de-collision nudges below the line.
const DETOUR_BOTTOM_MARGIN = 48;

export interface CanvasLaneLayout {
  readonly laneKey: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly estimatedHeight: number;
}

export interface CanvasLayout {
  readonly lanes: ReadonlyArray<CanvasLaneLayout>;
  readonly width: number;
  readonly height: number;
}

export type LaneHeights = Readonly<Record<string, number>>;

export interface LanePosition {
  readonly x: number;
  readonly y: number;
}

/**
 * Local, non-persisted per-lane position overrides. When a lane has an override
 * it is placed at that absolute position instead of its auto-flow slot; the
 * auto-flow cursor for the remaining lanes is unaffected (the moved lane simply
 * vacates its slot). Used purely to let the reader rearrange the canvas while
 * inspecting a workflow — it is never written back to the board file.
 */
export type LanePositions = Readonly<Record<string, LanePosition>>;

export const estimateLaneHeight = (lane: WorkflowDefinitionEncoded["lanes"][number]): number =>
  LANE_BASE_HEIGHT + (lane.pipeline?.length ?? 0) * STEP_BLOCK_HEIGHT;

// Layered left-to-right layout: a lane's column is its longest forward path
// from a root, following step routes, transitions, lane fallbacks, and
// actions. Only edges that point from an earlier-defined lane to a
// later-defined one count — definition order encodes the author's intended
// flow, so loops (bounded review re-entry, "back to backlog" actions) are
// treated as back-edges and never smear the graph. Lanes sharing a column
// stack vertically in definition order.
const laneDepths = (definition: WorkflowDefinitionEncoded): ReadonlyMap<string, number> => {
  const laneOrder = new Map(definition.lanes.map((lane, index) => [String(lane.key), index]));
  const depths = new Map<string, number>();

  const forwardTargets = (lane: WorkflowDefinitionEncoded["lanes"][number]): Set<string> => {
    const laneKey = String(lane.key);
    const laneIndex = laneOrder.get(laneKey) ?? 0;
    const targets = new Set<string>();
    const add = (to: unknown) => {
      if (to === undefined) {
        return;
      }
      const target = String(to);
      const targetIndex = laneOrder.get(target);
      if (targetIndex !== undefined && targetIndex > laneIndex) {
        targets.add(target);
      }
    };
    for (const step of lane.pipeline ?? []) {
      add(step.on?.success);
      add(step.on?.failure);
      add(step.on?.blocked);
    }
    for (const transition of lane.transitions ?? []) {
      add(transition.to);
    }
    add(lane.on?.success);
    add(lane.on?.failure);
    add(lane.on?.blocked);
    for (const action of lane.actions ?? []) {
      add(action.to);
    }
    return targets;
  };

  for (const lane of definition.lanes) {
    const laneKey = String(lane.key);
    const depth = depths.get(laneKey) ?? 0;
    depths.set(laneKey, depth);
    for (const target of forwardTargets(lane)) {
      depths.set(target, Math.max(depths.get(target) ?? 0, depth + 1));
    }
  }

  return depths;
};

export const computeCanvasLayout = (
  definition: WorkflowDefinitionEncoded,
  containerWidth: number,
  laneHeights: LaneHeights = {},
  lanePositions: LanePositions = {},
): CanvasLayout => {
  const availableWidth = Math.max(LANE_CARD_WIDTH, Math.floor(containerWidth));
  const depths = laneDepths(definition);
  const columnCursorY = new Map<number, number>();
  const slots = new Map<string, { x: number; y: number; height: number; overridden: boolean }>();

  for (const lane of definition.lanes) {
    const laneKey = String(lane.key);
    const laneHeight = laneHeights[laneKey] ?? estimateLaneHeight(lane);
    const column = depths.get(laneKey) ?? 0;
    const slotX = column * (LANE_CARD_WIDTH + LANE_GAP_X);
    const slotY = columnCursorY.get(column) ?? 0;
    columnCursorY.set(column, slotY + laneHeight + LANE_GAP_Y);
    const override = lanePositions[laneKey];
    slots.set(laneKey, {
      x: override?.x ?? slotX,
      y: override?.y ?? slotY,
      height: laneHeight,
      overridden: override !== undefined,
    });
  }

  const lanes: CanvasLaneLayout[] = [];
  let maxWidth = LANE_CARD_WIDTH;
  let maxBottom = 0;

  for (const lane of definition.lanes) {
    const laneKey = String(lane.key);
    const slot = slots.get(laneKey);
    if (!slot) {
      continue;
    }
    lanes.push({
      laneKey,
      x: slot.x,
      y: slot.y,
      width: LANE_CARD_WIDTH,
      estimatedHeight: slot.height,
    });
    maxWidth = Math.max(maxWidth, slot.x + LANE_CARD_WIDTH);
    maxBottom = Math.max(maxBottom, slot.y + slot.height);
  }

  // Reserve room below the cards for the deepest local detour track. Channel
  // edges (multi-column spans / back-edges) drop into a packed lane just below
  // the cards they pass over; without this the bottom-most detour would be
  // clipped off the scrollable surface.
  const detourExtent = computeDetourExtent(definition, slots);

  return {
    lanes,
    width: Math.max(maxWidth, availableWidth),
    height: lanes.length === 0 ? 0 : Math.max(maxBottom, detourExtent + DETOUR_BOTTOM_MARGIN),
  };
};

/**
 * Deepest local-detour track Y across all channel edges, computed from the same
 * span/packing primitives the renderer uses (card centers, ignoring per-edge
 * port fan-out) so the reserved depth matches the router's bottom-most line.
 * Enumeration MUST mirror `deriveRoutingEdges` in RoutingEdges.tsx.
 */
const computeDetourExtent = (
  definition: WorkflowDefinitionEncoded,
  slots: ReadonlyMap<string, { readonly x: number; readonly y: number; readonly height: number }>,
): number => {
  const rectOf = (laneKey: string): EdgeRect | null => {
    const slot = slots.get(laneKey);
    return slot ? { x: slot.x, y: slot.y, width: LANE_CARD_WIDTH, height: slot.height } : null;
  };
  const cards: EdgeRect[] = [];
  for (const [, slot] of slots) {
    cards.push({ x: slot.x, y: slot.y, width: LANE_CARD_WIDTH, height: slot.height });
  }
  const centerX = (rect: EdgeRect): number => rect.x + rect.width / 2;

  const spans: DetourSpan[] = [];
  const addSpan = (fromKey: string, to: unknown) => {
    const targetKey = String(to);
    if (targetKey === fromKey) {
      return;
    }
    const source = rectOf(fromKey);
    const target = rectOf(targetKey);
    if (!source || !target) {
      return;
    }
    if (classifyEdge(source, target).kind !== "channel") {
      return;
    }
    const left = Math.min(centerX(source), centerX(target));
    const right = Math.max(centerX(source), centerX(target));
    spans.push({ left, right, clearBottom: clearBottomForSpan(left, right, cards) });
  };

  for (const lane of definition.lanes) {
    const laneKey = String(lane.key);
    for (const step of lane.pipeline ?? []) {
      addSpan(laneKey, step.on?.success);
      addSpan(laneKey, step.on?.failure);
      addSpan(laneKey, step.on?.blocked);
    }
    for (const transition of lane.transitions ?? []) {
      addSpan(laneKey, transition.to);
    }
    addSpan(laneKey, lane.on?.success);
    addSpan(laneKey, lane.on?.failure);
    addSpan(laneKey, lane.on?.blocked);
    for (const action of lane.actions ?? []) {
      addSpan(laneKey, action.to);
    }
  }

  return spans.length === 0 ? 0 : packDetourLanes(spans).extent;
};
