/**
 * Story-frame sizing, deterministic masonry packing, scene bounds, the
 * fit-to-bounds camera solve, and epic affinity ordering (§3.4, §3.2, §4). Split
 * out of t3work-planningSpaceScene.ts.
 */

import {
  FOCAL,
  type PlanningCamera,
  type Viewport,
  Z_STORY,
} from "./t3work-planningSpaceScene";

/**
 * Story frame sizing (§3.4): a deterministic function of subtask count, using
 * the largest pre-planet band's CSS sizes as the packing budget.
 */
export const FRAME_WIDTH_BUDGET = 424;
export const FRAME_HEADER_HEIGHT = 88;
export const SUBTASK_CELL_HEIGHT = 66;
export const FRAME_PADDING = 24;
export const FRAME_GAP = 30;

export function frameHeight(subtaskCount: number): number {
  if (subtaskCount === 0) return FRAME_HEADER_HEIGHT + FRAME_PADDING;
  return FRAME_HEADER_HEIGHT + Math.ceil(subtaskCount / 2) * SUBTASK_CELL_HEIGHT + FRAME_PADDING;
}

export interface PackedFrame {
  readonly id: string;
  readonly centerX: number;
  readonly centerY: number;
  readonly height: number;
}

/**
 * Deterministic shortest-column masonry (§3.4). Items keep input order;
 * each goes to the currently shortest column. Returns packed centers and the
 * total packed height.
 */
export function packMasonry(
  items: ReadonlyArray<{ id: string; height: number }>,
  columnXs: ReadonlyArray<number>,
  startY: number,
  gap: number = FRAME_GAP,
): { frames: PackedFrame[]; totalHeight: number } {
  const columnHeights = columnXs.map(() => startY);
  const frames: PackedFrame[] = [];
  for (const item of items) {
    let column = 0;
    for (let i = 1; i < columnHeights.length; i++) {
      if ((columnHeights[i] ?? Infinity) < (columnHeights[column] ?? Infinity)) {
        column = i;
      }
    }
    const columnX = columnXs[column] ?? 0;
    const columnY = columnHeights[column] ?? startY;
    frames.push({
      id: item.id,
      centerX: columnX,
      centerY: columnY + item.height / 2,
      height: item.height,
    });
    columnHeights[column] = columnY + item.height + gap;
  }
  return { frames, totalHeight: Math.max(...columnHeights, startY) - startY };
}

export interface SceneBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export function boundsOfFrames(
  frames: ReadonlyArray<PackedFrame>,
  halfWidth: number = FRAME_WIDTH_BUDGET / 2,
): SceneBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const f of frames) {
    minX = Math.min(minX, f.centerX - halfWidth);
    maxX = Math.max(maxX, f.centerX + halfWidth);
    minY = Math.min(minY, f.centerY - f.height / 2);
    maxY = Math.max(maxY, f.centerY + f.height / 2);
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Fit camera target so the bounds are fully visible (§3.2 All-adjacent fit and
 * epic framing). Margin is screen pixels reserved around the content.
 */
export function fitCameraToBounds(
  bounds: SceneBounds,
  viewport: Viewport,
  margin: number = 120,
  zFloor: number = -6400,
): PlanningCamera {
  const extentW = bounds.maxX - bounds.minX + margin;
  const extentH = bounds.maxY - bounds.minY + margin;
  const scale = Math.min(viewport.width / extentW, viewport.height / extentH);
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: Math.max(zFloor, FOCAL + Z_STORY - FOCAL / scale),
  };
}

/**
 * Epic ordering by link affinity (§4): greedy placement so epics whose stories
 * reference each other sit adjacent. Affinity to the last placed epics
 * dominates; story count breaks ties. Deterministic for stable layouts.
 */
export function orderEpicsByAffinity(
  epicIds: ReadonlyArray<string>,
  storyCountByEpic: ReadonlyMap<string, number>,
  affinity: ReadonlyMap<string, ReadonlyMap<string, number>>,
  neighborhood: number = 4,
): string[] {
  const remaining = [...epicIds].sort(
    (a, b) =>
      (storyCountByEpic.get(b) ?? 0) - (storyCountByEpic.get(a) ?? 0) || a.localeCompare(b),
  );
  const ordered: string[] = [];
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -1;
    const recent = ordered.slice(-neighborhood);
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      if (candidate === undefined) continue;
      let linkScore = 0;
      for (const placed of recent) {
        linkScore += affinity.get(candidate)?.get(placed) ?? 0;
      }
      const score = linkScore * 1000 + (storyCountByEpic.get(candidate) ?? 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const picked = remaining.splice(bestIndex, 1)[0];
    if (picked !== undefined) ordered.push(picked);
  }
  return ordered;
}
