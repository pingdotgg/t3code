/**
 * Props type + memo comparator for the planning story frame. The frame only
 * re-renders when its story/color/refs change or when the assign affordance
 * starts/stops touching this story. Extracted from t3work-PlanningSpaceView.tsx.
 */

import type { PlanningStory } from "./t3work-planningSpaceData";
import type { PlanningItemRef } from "./t3work-planningSpaceInteractions";

export interface PlanningStoryFrameProps {
  story: PlanningStory;
  color: string;
  frameRef: (el: HTMLDivElement | null) => void;
  assignTarget: PlanningItemRef | null;
  onSetSubtaskHours: (subtaskId: string, seconds: number) => void;
  onContextMenu?: ((event: React.MouseEvent, ticketId: string) => void) | undefined;
}

function assignTargetTouchesStory(target: PlanningItemRef | null, storyId: string): boolean {
  return target?.storyId === storyId;
}

export function arePlanningStoryFramePropsEqual(
  prev: PlanningStoryFrameProps,
  next: PlanningStoryFrameProps,
): boolean {
  if (
    prev.story !== next.story ||
    prev.color !== next.color ||
    prev.frameRef !== next.frameRef ||
    prev.onSetSubtaskHours !== next.onSetSubtaskHours ||
    prev.onContextMenu !== next.onContextMenu
  ) {
    return false;
  }
  const storyId = prev.story.id;
  const prevTouch = assignTargetTouchesStory(prev.assignTarget, storyId);
  const nextTouch = assignTargetTouchesStory(next.assignTarget, storyId);
  return prevTouch === nextTouch && (!prevTouch || prev.assignTarget === next.assignTarget);
}
