/**
 * DOM/navigation handlers for the planning space: layout-target application,
 * hit-testing, drop-context derivation, node ref-callbacks, Full-band sibling
 * navigation, and gauge clicks. Each reads live state from the controller's
 * `ctxRef`. Extracted verbatim from t3work-PlanningSpaceView.tsx.
 */

import type { MutableRefObject } from "react";

import type { DropContext, PlanningHit } from "./t3work-planningSpaceInteractions";
import { UNASSIGNED_OWNER_KEY } from "./t3work-planningSpaceLayout";
import {
  navigatePlanningItem,
  resolvePlanningNavigationCurrentId,
} from "./t3work-planningSpaceNavigation";
import { cameraZForStoryScale } from "./t3work-planningSpaceScene";
import type { EngineEdge } from "./t3work-planningSpaceRenderer";
import { GAUGE_ANCHOR_SCALES } from "./t3work-planningSpaceViewConstants";
import { createPlanningDropContext, planningHitOf } from "./t3work-planningSpaceHitTest";
import type { PlanningSpaceCtx } from "./t3work-planningSpaceControllerTypes";

type NodeKind = "frame" | "epic" | "owner";

export interface PlanningSpaceDomHandlers {
  applyLayoutTargets: () => void;
  hitOf: (target: Element | null) => PlanningHit;
  dropContext: () => DropContext;
  nodeRef: (key: string, kind: NodeKind) => (el: HTMLDivElement | null) => void;
  navigateSibling: (direction: 1 | -1) => void;
  onGaugeClick: (labelIndex: number) => void;
}

export function createPlanningSpaceDomHandlers(
  ctxRef: MutableRefObject<PlanningSpaceCtx>,
): PlanningSpaceDomHandlers {
  const applyLayoutTargets = () => {
    const c = ctxRef.current;
    const { data, layout } = c.vm;
    const engine = c.engineRef.current;
    if (!engine) return;
    const keepIds = new Set<string>();
    for (const [id, record] of c.nodeEls.current) {
      keepIds.add(id);
      engine.registerNode(
        id,
        record.kind,
        record.el,
        record.el.querySelector(":scope > .t3ps-inner"),
      );
    }
    engine.pruneNodes(keepIds);
    const positions = new Map<string, { x: number; y: number }>();
    for (const [id, frame] of layout.frames) {
      positions.set(id, { x: frame.centerX, y: frame.centerY });
    }
    for (const [id, anchor] of layout.anchors) {
      positions.set(`anchor:${id}`, anchor);
    }
    engine.setTargets(positions);
    // Solo strength (§5.2): stories outside the packed layout disappear
    // entirely instead of dimming.
    for (const [id, record] of c.nodeEls.current) {
      if (record.kind !== "frame") continue;
      record.el.style.display = layout.frames.has(id) ? "" : "none";
    }
    const edges: EngineEdge[] = [];
    for (const story of data.stories) {
      const el = c.edgeRefs.current.get(story.id);
      if (!el) continue;
      const anchorKey =
        c.grouping === "owner"
          ? `anchor:${story.ownerId ?? UNASSIGNED_OWNER_KEY}`
          : `anchor:${story.epicId}`;
      if (!layout.anchors.has(anchorKey.slice("anchor:".length))) continue;
      edges.push({ el, fromId: anchorKey, toId: story.id });
    }
    engine.setEdges(edges);
  };
  const nodeRef = (key: string, kind: NodeKind) => {
    const c = ctxRef.current;
    let ref = c.refCache.current.get(key);
    if (!ref) {
      ref = (el: HTMLDivElement | null) => {
        if (el) {
          c.nodeEls.current.set(key, { kind, el });
          const engine = c.engineRef.current;
          if (engine) {
            engine.registerNode(key, kind, el, el.querySelector(":scope > .t3ps-inner"));
          }
        } else {
          c.nodeEls.current.delete(key);
        }
      };
      c.refCache.current.set(key, ref);
    }
    return ref;
  };

  /**
   * Full-band prev/next (§3.5): global reading order across parent clusters;
   * when filters are active, only filter-matched stories are visited.
   */
  const navigateSibling = (direction: 1 | -1) => {
    const c = ctxRef.current;
    const { layout, storyById, navigationClusterOrder, filtersActive, storyMatches } = c.vm;
    const engine = c.engineRef.current;
    if (!engine || layout.frames.size === 0) return;
    const currentId = resolvePlanningNavigationCurrentId({
      frames: layout.frames,
      camera: engine.cameraTargetSnapshot,
      snapTargetId: c.snapTargetRef.current,
    });
    if (!currentId) return;
    const next = navigatePlanningItem({
      grouping: c.grouping,
      frames: layout.frames,
      storyById,
      clusterOrder: navigationClusterOrder,
      filtersActive,
      storyMatches,
      currentId,
      direction,
    });
    if (!next) return;
    c.snapTargetRef.current = next.id;
    c.userNavigated.current = true;
    engine.flyTo(next.frame.centerX, next.frame.centerY);
  };

  const onGaugeClick = (labelIndex: number) => {
    const c = ctxRef.current;
    const engine = c.engineRef.current;
    if (!engine) return;
    c.userNavigated.current = true;
    if (labelIndex === 0) {
      // Smooth hand-off: remember where the user was, then zoom the world out
      // to its full extent beneath the fading overlay.
      c.cameraBeforeAll.current = engine.cameraTargetSnapshot;
      engine.fitBounds(c.vm.layout.bounds);
      c.setAllMode(true);
      return;
    }
    const scale = GAUGE_ANCHOR_SCALES[labelIndex - 1];
    if (scale === undefined) return;
    const z = cameraZForStoryScale(scale);
    if (c.allMode && c.cameraBeforeAll.current) {
      // Leaving All via a band label returns to the pre-All position at the
      // requested depth instead of the arbitrary fit center.
      engine.setCameraTarget({
        x: c.cameraBeforeAll.current.x,
        y: c.cameraBeforeAll.current.y,
        z,
      });
      c.cameraBeforeAll.current = null;
    } else {
      engine.setCameraZ(z);
    }
    c.setAllMode(false);
  };

  return {
    applyLayoutTargets,
    hitOf: planningHitOf,
    dropContext: createPlanningDropContext(ctxRef),
    nodeRef,
    navigateSibling,
    onGaugeClick,
  };
}
