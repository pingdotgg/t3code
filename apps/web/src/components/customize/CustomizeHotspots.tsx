import { PencilIcon } from "lucide-react";
import { type WheelEvent } from "react";

import { cn } from "../../lib/utils";
import { type Rect } from "./customizeEdit.logic";
import { measureSurface } from "./CustomizeEditLayer";
import { type EditSurface } from "./customizeInterfaceStore";
import { readElementRect, SURFACE_SELECTORS, useLiveMeasure } from "./customizeTargets";

// Labels sit on the side away from the popover, which opens beside the sidebar.
const HOTSPOTS: ReadonlyArray<{ surface: EditSurface; label: string; align: "start" | "end" }> = [
  { surface: "threadRow", label: "Thread rows", align: "start" },
  { surface: "chatHeader", label: "Header", align: "end" },
  { surface: "composer", label: "Composer", align: "end" },
];

const PAD = 6;
const LINE_HEIGHT = 16;
/** Room a label needs above a surface before it moves below instead. */
const LABEL_CLEARANCE = 28;

function measureHotspots(): Record<EditSurface, Rect | null> {
  return {
    threadRow: measureSurface("threadRow").root,
    // A narrow header folds its actions into a menu; its trigger stands in for them.
    chatHeader: measureSurface("chatHeader").root ?? readCollapsedHeaderActions(),
    composer: measureSurface("composer").root,
  };
}

function readCollapsedHeaderActions(): Rect | null {
  const trigger = document.querySelector(
    `${SURFACE_SELECTORS.header} [aria-label="More header actions"]`,
  );
  return trigger ? readElementRect(trigger) : null;
}

/** Frames sit above scrolling lists, so pass the wheel to whatever scrolls underneath. */
function scrollUnderneath(event: WheelEvent<HTMLElement>) {
  const frame = event.currentTarget;
  const below = document
    .elementsFromPoint(event.clientX, event.clientY)
    .find((element) => element !== frame && !frame.contains(element));
  for (let element = below ?? null; element; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      element.scrollHeight > element.clientHeight
    ) {
      // Wheel deltas can arrive in lines or pages rather than pixels.
      const unit =
        event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? element.clientHeight : 1;
      element.scrollBy({ top: event.deltaY * unit, left: event.deltaX * unit });
      return;
    }
  }
}

/**
 * Outlines every surface that can be edited in place, so the mode shows what
 * it can change before anyone reads the popover. Clicking one starts editing
 * it; hovering its fine-tune row in the popover lights it up.
 */
export function CustomizeHotspots({
  visible,
  highlighted,
  onEdit,
}: {
  visible: boolean;
  highlighted: EditSurface | null;
  onEdit: (surface: EditSurface) => void;
}) {
  const rects = useLiveMeasure(measureHotspots, "hotspots");
  return (
    <>
      {HOTSPOTS.map(({ surface, label, align }, index) => {
        const rect = rects[surface];
        if (!rect) return null;
        const labelBelow = rect.top - PAD < LABEL_CLEARANCE;
        return (
          <button
            key={surface}
            type="button"
            data-customize-hotspot={surface}
            data-highlighted={highlighted === surface || undefined}
            aria-label={`Edit ${label.toLowerCase()}`}
            onClick={() => onEdit(surface)}
            onWheel={scrollUnderneath}
            style={{
              left: rect.left - PAD,
              top: rect.top - PAD,
              width: rect.right - rect.left + PAD * 2,
              height: rect.bottom - rect.top + PAD * 2,
              transitionDelay: visible ? `${60 + index * 50}ms` : "0ms",
            }}
            className={cn(
              "group/hotspot pointer-events-auto fixed z-[104] cursor-pointer rounded-xl border-2 border-dashed border-primary/60 bg-primary/[0.04] outline-none",
              "transition-[opacity,scale,background-color,border-color] duration-200 ease-out motion-reduce:transition-opacity",
              "hover:border-solid hover:border-primary hover:bg-primary/10 focus-visible:border-solid focus-visible:border-primary focus-visible:bg-primary/10",
              "data-highlighted:border-solid data-highlighted:border-primary data-highlighted:bg-primary/10",
              visible ? "scale-100 opacity-100" : "pointer-events-none scale-[1.02] opacity-0",
            )}
          >
            <span
              className={cn(
                "absolute flex items-center gap-1.5 rounded-full bg-primary py-0.5 pr-2.5 pl-2 text-xs font-medium whitespace-nowrap text-primary-foreground shadow-sm [&_svg]:size-3",
                labelBelow ? "top-full mt-1.5" : "bottom-full mb-1.5",
                align === "start" ? "left-2" : "right-2",
              )}
            >
              <PencilIcon />
              {label}
              <span className="font-normal opacity-80">· Reorder or hide</span>
            </span>
          </button>
        );
      })}
    </>
  );
}
