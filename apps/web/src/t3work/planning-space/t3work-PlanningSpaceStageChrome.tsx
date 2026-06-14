/**
 * Stage overlay chrome for the planning space: the depth gauge (drag track,
 * marker, band labels), the Full-band prev/next siblings, the owner rail, and
 * the drag ghost. Extracted from t3work-PlanningSpaceView.tsx.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";

import { PlanningSpaceRail } from "./t3work-PlanningSpaceRail";
import { cameraZForStoryScale } from "./t3work-planningSpaceScene";
import { planningGaugeScaleForT } from "./t3work-planningSpaceViewGaugeMath";
import type { PlanningSpaceController } from "./t3work-usePlanningSpaceController";
import { DEFAULT_CAPACITY_SECONDS, GAUGE_LABELS } from "./t3work-planningSpaceViewConstants";

export function PlanningSpaceStageChrome({ c }: { c: PlanningSpaceController }) {
  const { vm } = c;
  return (
    <>
      <div
        data-ps-chrome="true"
        className="absolute left-3 top-1/2 z-30 flex -translate-y-1/2 gap-2 rounded-md border border-border/50 bg-background/80 px-2 py-1 backdrop-blur-sm"
      >
        <div
          className="relative my-1 w-3 cursor-ns-resize"
          data-testid="planning-space-gauge-track"
          onPointerDown={(event) => {
            const track = event.currentTarget;
            const engine = c.engineRef.current;
            if (!engine) return;
            c.userNavigated.current = true;
            c.setAllMode(false);
            track.setPointerCapture(event.pointerId);
            const applyFromY = (clientY: number) => {
              const rect = track.getBoundingClientRect();
              const t = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
              engine.setCameraZ(cameraZForStoryScale(planningGaugeScaleForT(engine, t)));
            };
            applyFromY(event.clientY);
            const onMove = (move: PointerEvent) => applyFromY(move.clientY);
            const onUp = () => {
              track.removeEventListener("pointermove", onMove);
              track.removeEventListener("pointerup", onUp);
            };
            track.addEventListener("pointermove", onMove);
            track.addEventListener("pointerup", onUp);
          }}
        >
          <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-border" />
          <div
            ref={c.gaugeMarkerRef}
            className="absolute left-1/2 size-[11px] -translate-x-1/2 rounded-full bg-primary"
          />
        </div>
        <div className="flex flex-col justify-between py-0.5">
          {GAUGE_LABELS.map((label, index) => (
            <button
              key={label}
              type="button"
              ref={(el) => {
                if (el) c.gaugeButtonRefs.current.set(label, el);
                else c.gaugeButtonRefs.current.delete(label);
              }}
              onClick={() => c.handlers.onGaugeClick(index)}
              className="text-left text-[9px] leading-6 text-muted-foreground hover:text-foreground"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        ref={c.navPrevRef}
        data-ps-chrome="true"
        aria-label="Previous item"
        onClick={() => c.handlers.navigateSibling(-1)}
        style={{ display: "none" }}
        className="absolute left-24 top-1/2 z-30 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border border-border/60 bg-background/85 text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
      </button>
      <button
        type="button"
        ref={c.navNextRef}
        data-ps-chrome="true"
        aria-label="Next item"
        onClick={() => c.handlers.navigateSibling(1)}
        style={{ display: "none" }}
        className="absolute right-3 top-1/2 z-30 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border border-border/60 bg-background/85 text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground"
      >
        <ChevronRight className="size-4" />
      </button>

      <PlanningSpaceRail
        owners={vm.data.owners}
        unassignedCount={
          vm.data.stories.filter((s) => s.ownerId === null).length +
          vm.data.stories.reduce(
            (count, story) => count + story.subtasks.filter((s) => s.ownerId === null).length,
            0,
          )
        }
        capacitySeconds={DEFAULT_CAPACITY_SECONDS}
        ownerCapacities={c.ownerCapacities}
        open={c.railOpen}
        lifted={c.dragActive || c.assignTarget !== null}
        spotlightOwnerId={c.spotlight?.kind === "owner" ? c.spotlight.ownerId : undefined}
        ownerRoles={c.ownerRoles}
        onToggle={() => c.setRailUserOpen(!c.railOpen)}
      />

      <div
        ref={c.ghostRef}
        className="pointer-events-none absolute z-30 hidden max-w-44 truncate rounded-md border border-primary/60 bg-background px-2 py-1 text-[10px] text-foreground shadow-none"
        style={{ display: "none" }}
      />
    </>
  );
}
