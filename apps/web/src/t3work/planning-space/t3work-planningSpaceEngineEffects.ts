/**
 * Engine-driven effects for the planning space: the engine lifecycle (creation,
 * band/frame listeners, the Full-band magnet, resize observer), layout-target
 * application, detail restart, band-chrome sync, initial auto-fit, deferred
 * owner framing, and spotlight/detail dimming. Each captures the controller ctx
 * from its subscribe render. Extracted verbatim from t3work-PlanningSpaceView.tsx.
 */

import { type MutableRefObject, useEffect } from "react";

import { UNASSIGNED_OWNER_KEY } from "./t3work-planningSpaceLayout";
import { PlanningSpaceEngine } from "./t3work-planningSpaceRenderer";
import { Z_STORY, scaleForPlane } from "./t3work-planningSpaceScene";
import { planningGaugeTForScale } from "./t3work-planningSpaceViewGaugeMath";
import { syncPlanningBandChrome } from "./t3work-planningSpaceViewChromeSync";
import type { PlanningSpaceCtx } from "./t3work-planningSpaceControllerTypes";

export function usePlanningSpaceEngineEffects(ctxRef: MutableRefObject<PlanningSpaceCtx>): void {
  const c = ctxRef.current;

  useEffect(() => {
    const stage = c.stageRef.current;
    if (!stage) return;
    const engine = new PlanningSpaceEngine(stage);
    c.engineRef.current = engine;
    const syncBandChrome = () => {
      syncPlanningBandChrome({
        band: c.activeBandRef.current,
        allMode: c.allModeRef.current,
        gaugeButtons: c.gaugeButtonRefs.current,
        navPrev: c.navPrevRef.current,
        navNext: c.navNextRef.current,
      });
    };
    engine.setBandChangeListener((band) => {
      c.activeBandRef.current = band;
      const nextAtFull = band >= 5;
      if (c.atFullBandRef.current !== nextAtFull) {
        c.atFullBandRef.current = nextAtFull;
        c.setAtFullBand(nextAtFull);
      }
      syncBandChrome();
    });
    let magnetTick = 0;
    const removeFrameListener = engine.addFrameListener(() => {
      const marker = c.gaugeMarkerRef.current;
      if (marker) {
        const t = planningGaugeTForScale(engine, scaleForPlane(engine.cameraZTarget, Z_STORY));
        marker.style.top = `calc(${(Math.max(0, Math.min(1, t)) * 100).toFixed(2)}% - 5px)`;
      }
      const line = c.leaderRef.current;
      const detail = c.detailItemRef.current;
      if (line && detail && stage) {
        const position = engine.screenPositionOf(detail.storyId);
        if (position) {
          line.setAttribute("x1", String(position.x));
          line.setAttribute("y1", String(position.y));
          line.setAttribute("x2", String(stage.clientWidth - 300));
          line.setAttribute("y2", String(stage.clientHeight / 2));
          line.setAttribute("stroke-opacity", "0.45");
        } else {
          line.setAttribute("stroke-opacity", "0");
        }
      }
      magnetTick += 1;
      if ((magnetTick & 1) !== 0) return;
      const frames = c.layoutRef.current?.frames;
      if (
        !frames ||
        frames.size === 0 ||
        c.activeBandRef.current < 5 ||
        c.allModeRef.current ||
        c.machineState.current.pointer ||
        performance.now() - c.lastInputAt.current <= 400
      ) {
        return;
      }
      const cam = engine.cameraTargetSnapshot;
      let frame = c.snapTargetRef.current ? (frames.get(c.snapTargetRef.current) ?? null) : null;
      if (!frame) {
        let bestDistance = Infinity;
        for (const candidate of frames.values()) {
          const distance = (candidate.centerX - cam.x) ** 2 + (candidate.centerY - cam.y) ** 2;
          if (distance < bestDistance) {
            bestDistance = distance;
            frame = candidate;
          }
        }
      }
      if (!frame) return;
      const dx = frame.centerX - cam.x;
      const dy = frame.centerY - cam.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) {
        engine.setCameraTarget({ x: cam.x + dx * 0.06, y: cam.y + dy * 0.06, z: cam.z });
      }
    });
    engine.start();
    syncBandChrome();
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>)["__t3psEngine"] = engine;
    }
    c.setEngineReady(true);
    const observer = new ResizeObserver(() => {
      c.setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    });
    observer.observe(stage);
    c.setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    return () => {
      removeFrameListener();
      observer.disconnect();
      engine.stop();
      c.engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!c.engineReady) return;
    c.applyLayoutTargetsRef.current();
  }, [c.vm.layout, c.vm.data, c.grouping, c.engineReady]);

  useEffect(() => {
    if (!c.engineReady || !c.detailItem) return;
    c.engineRef.current?.start();
  }, [c.detailItem, c.engineReady]);

  useEffect(() => {
    syncPlanningBandChrome({
      band: c.activeBandRef.current,
      allMode: c.allMode,
      gaugeButtons: c.gaugeButtonRefs.current,
      navPrev: c.navPrevRef.current,
      navNext: c.navNextRef.current,
    });
  }, [c.allMode]);

  const layoutHasFrames = c.vm.layout.frames.size > 0;
  useEffect(() => {
    const engine = c.engineRef.current;
    const currentLayout = c.layoutRef.current;
    if (!engine || !c.engineReady || c.userNavigated.current) return;
    if (!currentLayout || !layoutHasFrames || c.stageSize.width === 0) {
      return;
    }
    const stageChanged =
      c.lastAutoFitStageSizeRef.current.width !== c.stageSize.width ||
      c.lastAutoFitStageSizeRef.current.height !== c.stageSize.height;
    if (c.initialFitDoneRef.current && !stageChanged) return;
    engine.fitBounds(currentLayout.bounds);
    c.initialFitDoneRef.current = true;
    c.lastAutoFitStageSizeRef.current = c.stageSize;
  }, [c.stageSize, c.engineReady, c.grouping, layoutHasFrames]);

  useEffect(() => {
    if (c.pendingFrameOwner === null || c.grouping !== "owner") return;
    const ownerId = c.pendingFrameOwner === UNASSIGNED_OWNER_KEY ? null : c.pendingFrameOwner;
    c.setPendingFrameOwner(null);
    c.frameGroupRef.current({ kind: "owner", ownerId });
  }, [c.pendingFrameOwner, c.grouping, c.vm.layout]);

  useEffect(() => {
    const engine = c.engineRef.current;
    if (!engine) return;
    const { data, layout, storyMatches, filtersActive, storyById, epicById } = c.vm;
    if (!filtersActive && !c.detailItem) {
      engine.setDimmedIds(null);
      return;
    }
    const keep = new Set<string>();
    for (const story of data.stories) {
      let bright = !filtersActive || storyMatches.has(story.id);
      if (bright && c.detailItem) {
        bright =
          story.id === c.detailItem.storyId ||
          story.epicId === storyById.get(c.detailItem.storyId)?.epicId;
      }
      if (bright) keep.add(story.id);
    }
    // Propagation (§5): group anchors stay bright only while any of their
    // members do — epics with zero matching stories dim with them.
    for (const [id] of layout.anchors) {
      const members = data.stories.filter((story) =>
        epicById.has(id) ? story.epicId === id : (story.ownerId ?? UNASSIGNED_OWNER_KEY) === id,
      );
      if (members.some((story) => keep.has(story.id))) {
        keep.add(`anchor:${id}`);
      }
    }
    engine.setDimmedIds(keep);
  }, [
    c.vm.filtersActive,
    c.vm.storyMatches,
    c.detailItem,
    c.vm.data,
    c.vm.layout,
    c.vm.storyById,
    c.vm.epicById,
  ]);
}
