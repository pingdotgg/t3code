/**
 * The stage pointer/wheel/keyboard effect — subscribes raw DOM listeners while
 * the engine is live, re-binding when grouping/layout/data change (matching the
 * original effect's deps). The move/up/cancel/dblclick/contextmenu/keydown
 * handlers live here; wheel + pointer-down + gesture state come from
 * t3work-planningSpacePointerGesture.ts. Extracted verbatim from
 * t3work-PlanningSpaceView.tsx.
 */

import { type MutableRefObject, useEffect } from "react";

import { createPlanningPointerGesture } from "./t3work-planningSpacePointerGesture";
import type { PlanningSpaceCtx } from "./t3work-planningSpaceControllerTypes";

export function usePlanningSpacePointerEffect(ctxRef: MutableRefObject<PlanningSpaceCtx>): void {
  const c = ctxRef.current;

  useEffect(() => {
    const stage = c.stageRef.current;
    const engine = c.engineRef.current;
    if (!stage || !engine || !c.engineReady) return;

    const g = createPlanningPointerGesture(ctxRef, stage, engine);

    const onPointerMove = (event: PointerEvent) => {
      c.lastInputAt.current = performance.now();
      if (c.machineState.current.dragging?.kind === "pan") {
        c.snapTargetRef.current = null;
      }
      if (g.activePointers.has(event.pointerId)) {
        g.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (g.pinch && g.activePointers.size >= 2) {
          const next = g.pinchFrom();
          if (next) {
            const rect = stage.getBoundingClientRect();
            c.userNavigated.current = true;
            c.setAllModeRef.current(false);
            engine.pinchZoomAt(
              next.midX - rect.left,
              next.midY - rect.top,
              next.distance / Math.max(1, g.pinch.distance),
            );
            engine.panByScreenDelta(next.midX - g.pinch.midX, next.midY - g.pinch.midY);
            g.pinch = next;
          }
          return;
        }
      }
      if (!c.machineState.current.pointer) return;
      c.userNavigated.current = true;
      const rect = stage.getBoundingClientRect();
      const world = engine.unprojectAtStoryPlane(event.clientX - rect.left, event.clientY - rect.top);
      c.handlers.dispatch({
        type: "pointerMove",
        x: event.clientX,
        y: event.clientY,
        worldX: world.x,
        worldY: world.y,
      });
      g.positionGhost(event);
      // Incremental pan: machine reports cumulative deltas, engine wants steps.
      if (c.machineState.current.dragging?.kind === "pan") {
        const pointer = c.machineState.current.pointer;
        if (pointer) {
          const dx = event.clientX - pointer.downX;
          const dy = event.clientY - pointer.downY;
          engine.panByScreenDelta(dx - g.lastPan.dx, dy - g.lastPan.dy);
          g.lastPan = { dx, dy };
        }
      }
      // Drop-target hot states while dragging a person onto an item.
      if (c.machineState.current.dragging?.kind === "person") {
        const hover = c.handlers.hitOf(document.elementFromPoint(event.clientX, event.clientY));
        let nextDropHot: Element | null = null;
        if (hover.type === "frame" || hover.type === "subtask") {
          const selector =
            hover.type === "subtask"
              ? `[data-subtask-id="${hover.subtaskId}"]`
              : `.t3ps-node[data-node-id="${hover.storyId}"] .t3ps-card`;
          nextDropHot = stage.querySelector(selector);
        }
        if (nextDropHot !== g.dropHotEl) {
          g.clearDropHot();
          g.dropHotEl = nextDropHot;
          g.dropHotEl?.setAttribute("data-drop-hot", "true");
        }
      } else if (g.dropHotEl) {
        g.clearDropHot();
      }
    };
    const onPointerCancel = (event: PointerEvent) => {
      g.activePointers.delete(event.pointerId);
      if (g.activePointers.size < 2) g.pinch = null;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (g.activePointers.has(event.pointerId)) {
        g.activePointers.delete(event.pointerId);
        if (g.activePointers.size < 2) g.pinch = null;
        if (g.pinch) return;
      }
      if (!c.machineState.current.pointer) return;
      const rect = stage.getBoundingClientRect();
      const world = engine.unprojectAtStoryPlane(event.clientX - rect.left, event.clientY - rect.top);
      g.clearDropHot();
      c.handlers.dispatch({
        type: "pointerUp",
        hit: c.handlers.hitOf(document.elementFromPoint(event.clientX, event.clientY)),
        worldX: world.x,
        worldY: world.y,
        drop: c.handlers.dropContext(),
      });
    };
    const onDoubleClick = (event: MouseEvent) => {
      c.handlers.dispatch({ type: "doubleClick", hit: c.handlers.hitOf(event.target as Element) });
    };
    const onContextMenuEvent = (event: MouseEvent) => {
      const hit = c.handlers.hitOf(event.target as Element);
      if (hit.type === "epicAnchor" || hit.type === "epicTile") {
        event.preventDefault();
        const rect = stage.getBoundingClientRect();
        c.setContextMenu({
          x: Math.min(event.clientX - rect.left, stage.clientWidth - 160),
          y: Math.min(event.clientY - rect.top, stage.clientHeight - 80),
          epicId: hit.epicId,
        });
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // View-level chrome closes first, one level per press (§6.7).
      if (c.contextMenuRef.current) {
        c.setContextMenu(null);
        return;
      }
      if (c.epicDetailRef.current !== null) {
        c.setEpicDetailId(null);
        return;
      }
      if (c.allModeRef.current) {
        const engineNow = c.engineRef.current;
        if (engineNow && c.cameraBeforeAll.current) {
          engineNow.setCameraTarget(c.cameraBeforeAll.current);
          c.cameraBeforeAll.current = null;
        }
        c.setAllModeRef.current(false);
        return;
      }
      c.handlers.dispatch({ type: "escape" });
    };
    stage.addEventListener("wheel", g.onWheel, { passive: false });
    stage.addEventListener("pointerdown", g.onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", onPointerCancel);
    stage.addEventListener("dblclick", onDoubleClick);
    stage.addEventListener("contextmenu", onContextMenuEvent);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      stage.removeEventListener("wheel", g.onWheel);
      stage.removeEventListener("pointerdown", g.onPointerDown);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerup", onPointerUp);
      stage.removeEventListener("pointercancel", onPointerCancel);
      stage.removeEventListener("dblclick", onDoubleClick);
      stage.removeEventListener("contextmenu", onContextMenuEvent);
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.engineReady, c.grouping, c.vm.layout, c.vm.data]);
}
