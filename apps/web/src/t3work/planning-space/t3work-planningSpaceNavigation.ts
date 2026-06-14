/**
 * Planning space Full-band prev/next navigation (spec §3.5).
 *
 * Pure module: builds a global reading order across parent clusters and
 * optionally restricts it to filter-matched stories.
 */

import type { PackedFrame } from "./t3work-planningSpaceScene";
import { UNASSIGNED_OWNER_KEY } from "./t3work-planningSpaceLayout";

export type PlanningNavigationGrouping = "epic" | "sprint" | "owner";

export interface PlanningNavigationStory {
  readonly epicId: string;
  readonly ownerId: string | null;
  readonly inSprint: boolean;
}

export function planningGroupKeyOf(
  story: PlanningNavigationStory,
  grouping: PlanningNavigationGrouping,
): string {
  if (grouping === "owner") return story.ownerId ?? UNASSIGNED_OWNER_KEY;
  if (grouping === "sprint") return String(story.inSprint);
  return story.epicId;
}

export interface PlanningNavigationInput {
  readonly grouping: PlanningNavigationGrouping;
  readonly frames: ReadonlyMap<string, PackedFrame>;
  readonly storyById: ReadonlyMap<string, PlanningNavigationStory>;
  /** Parent clusters in layout order (epic ids, owner ids + unassigned, or sprint sides). */
  readonly clusterOrder: ReadonlyArray<string>;
  readonly filtersActive: boolean;
  readonly storyMatches?: ReadonlySet<string> | undefined;
}

function frameSort(a: PackedFrame, b: PackedFrame): number {
  return a.centerY - b.centerY || a.centerX - b.centerX;
}

function storyIsNavigable(storyId: string, input: PlanningNavigationInput): boolean {
  if (!input.storyById.has(storyId)) return false;
  if (!input.filtersActive) return true;
  return input.storyMatches?.has(storyId) ?? false;
}

/**
 * Global reading order: clusters left-to-right / top-to-bottom, frames within
 * each cluster in masonry order (centerY, then centerX).
 */
export function buildPlanningNavigationOrder(input: PlanningNavigationInput): string[] {
  const order: string[] = [];
  for (const clusterKey of input.clusterOrder) {
    const clusterFrames = [...input.frames.entries()]
      .filter(([id]) => {
        const story = input.storyById.get(id);
        if (!story) return false;
        if (planningGroupKeyOf(story, input.grouping) !== clusterKey) return false;
        return storyIsNavigable(id, input);
      })
      .map(([id, frame]) => ({ id, frame }))
      .sort((a, b) => frameSort(a.frame, b.frame));
    for (const entry of clusterFrames) order.push(entry.id);
  }
  return order;
}

export function resolvePlanningNavigationCurrentId(input: {
  readonly frames: ReadonlyMap<string, PackedFrame>;
  readonly camera: { readonly x: number; readonly y: number };
  readonly snapTargetId: string | null;
}): string | null {
  const { frames, camera, snapTargetId } = input;
  if (frames.size === 0) return null;
  if (snapTargetId && frames.has(snapTargetId)) return snapTargetId;
  let bestId: string | null = null;
  let bestDistance = Infinity;
  for (const [id, frame] of frames) {
    const distance = (frame.centerX - camera.x) ** 2 + (frame.centerY - camera.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = id;
    }
  }
  return bestId;
}

export function navigatePlanningItem(
  input: PlanningNavigationInput & {
    readonly currentId: string;
    readonly direction: 1 | -1;
  },
): { readonly id: string; readonly frame: PackedFrame } | null {
  const order = buildPlanningNavigationOrder(input);
  if (order.length < 2) return null;
  let index = order.indexOf(input.currentId);
  if (index < 0) {
    // Current frame may be filtered out — treat as before the first match.
    index = input.direction === 1 ? -1 : order.length;
  }
  const nextId = order[(index + input.direction + order.length) % order.length];
  if (!nextId) return null;
  const frame = input.frames.get(nextId);
  if (!frame) return null;
  return { id: nextId, frame };
}
