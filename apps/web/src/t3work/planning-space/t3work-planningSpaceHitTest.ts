/**
 * Stage hit-testing for the planning space: maps a DOM target to a semantic
 * `PlanningHit` (affordance / subtask / frame / dock / owner-header / epic), and
 * derives the drop context for person drags. Extracted verbatim from
 * t3work-PlanningSpaceView.tsx.
 */

import type { MutableRefObject } from "react";

import type { DropContext, PlanningHit } from "./t3work-planningSpaceInteractions";
import { UNASSIGNED_OWNER_KEY } from "./t3work-planningSpaceLayout";
import { UNASSIGNED_DOCK_ID } from "./t3work-PlanningSpaceRail";
import type { PlanningSpaceCtx } from "./t3work-planningSpaceControllerTypes";

export function planningHitOf(target: Element | null): PlanningHit {
  if (!target) return { type: "background" };
  const affordance = target.closest("[data-owner-affordance]");
  if (affordance) {
    const storyId = affordance.getAttribute("data-story-id") ?? "";
    const subtaskId = affordance.getAttribute("data-subtask-id");
    return {
      type: "ownerAffordance",
      item: subtaskId ? { kind: "subtask", storyId, subtaskId } : { kind: "story", storyId },
    };
  }
  const subtask = target.closest("[data-subtask-id]");
  const frame = target.closest(".t3ps-node[data-node-id]");
  const band = frame ? Number((frame as HTMLElement).dataset["band"] ?? 0) : 0;
  if (subtask && frame) {
    return {
      type: "subtask",
      storyId: (frame as HTMLElement).dataset["nodeId"] ?? "",
      subtaskId: subtask.getAttribute("data-subtask-id") ?? "",
      band,
    };
  }
  if (frame) {
    const storyId = (frame as HTMLElement).dataset["nodeId"] ?? "";
    if (band >= 5 && !target.closest(".t3ps-header")) {
      return { type: "background" };
    }
    return { type: "frame", storyId, band };
  }
  const dock = target.closest("[data-dock]");
  if (dock) {
    const raw = dock.getAttribute("data-dock");
    return { type: "dock", ownerId: raw === UNASSIGNED_DOCK_ID ? null : raw };
  }
  const ownerHeader = target.closest("[data-owner-header]");
  if (ownerHeader) {
    const raw = ownerHeader.getAttribute("data-owner-header");
    return { type: "ownerHeader", ownerId: raw === UNASSIGNED_OWNER_KEY ? null : raw };
  }
  const epicAnchor = target.closest("[data-epic-anchor]");
  if (epicAnchor) {
    return { type: "epicAnchor", epicId: epicAnchor.getAttribute("data-epic-anchor") ?? "" };
  }
  const epicTile = target.closest("[data-epic-tile]");
  if (epicTile) {
    return { type: "epicTile", epicId: epicTile.getAttribute("data-epic-tile") ?? "" };
  }
  return { type: "background" };
}

export function createPlanningDropContext(
  ctxRef: MutableRefObject<PlanningSpaceCtx>,
): () => DropContext {
  return () => {
    const c = ctxRef.current;
    return {
      grouping: c.grouping,
      sprintBoundaryX: 0,
      ownerClusters: [...c.vm.layout.anchors.entries()]
        .filter(([id]) => !c.vm.epicById.has(id))
        .map(([id, anchor]) => ({
          ownerId: id === UNASSIGNED_OWNER_KEY ? null : id,
          x: anchor.x,
          y: anchor.y,
        })),
    };
  };
}
