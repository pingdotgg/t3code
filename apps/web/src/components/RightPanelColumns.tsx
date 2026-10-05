import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { RightPanelSurface } from "../rightPanelStore";

export interface RightPanelColumnView {
  /** The surface the tab bar has selected; it owns focus and keyboard shortcuts. */
  active: boolean;
  /** Whether any part of the column is inside the strip. */
  visible: boolean;
  /**
   * Whether the whole column is inside the strip. Native browser views draw
   * above the DOM and ignore its clipping, so they only show when this is true.
   */
  unclipped: boolean;
}

// A column counts as fully shown once this much of it is inside the strip.
const FULLY_VISIBLE_RATIO = 0.99;

/**
 * Lays every open right panel surface out side by side on a horizontally
 * scrolling strip. The tab bar stays the overview: selecting a tab scrolls its
 * column into view, and pressing inside a column selects its tab. Focus alone
 * does not select: selecting a terminal focuses it, which would pull focus off
 * whatever control the keyboard reached, and panels that focus themselves would
 * take turns selecting.
 */
export function RightPanelColumns(props: {
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  /** Changes whenever a surface is selected, even the current one, to scroll it into view. */
  revealRequestId: number;
  onActivate: (surface: RightPanelSurface) => void;
  renderSurface: (surface: RightPanelSurface, view: RightPanelColumnView) => ReactNode;
}) {
  const { surfaces, activeSurfaceId, revealRequestId, onActivate, renderSurface } = props;
  const stripRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  const [visibility, setVisibility] = useState<ReadonlyMap<string, "partial" | "full">>(
    () => new Map(),
  );
  const surfaceIdsKey = surfaces.map((surface) => surface.id).join("\n");

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    // Forget removed columns, so one reopened under the same id starts hidden
    // until the observer measures it.
    const ids = new Set(surfaceIdsKey.split("\n"));
    setVisibility((current) =>
      [...current.keys()].every((id) => ids.has(id))
        ? current
        : new Map([...current].filter(([id]) => ids.has(id))),
    );
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibility((current) => {
          const next = new Map(current);
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.rightPanelColumn;
            if (!id) continue;
            if (entry.intersectionRatio >= FULLY_VISIBLE_RATIO) next.set(id, "full");
            else if (entry.isIntersecting) next.set(id, "partial");
            else next.delete(id);
          }
          if (
            next.size === current.size &&
            [...next].every(([id, value]) => current.get(id) === value)
          ) {
            return current;
          }
          return next;
        });
      },
      { root: strip, threshold: [0, FULLY_VISIBLE_RATIO] },
    );
    for (const id of ids) {
      const column = columnRefs.current.get(id);
      if (column) observer.observe(column);
    }
    return () => observer.disconnect();
  }, [surfaceIdsKey]);

  useEffect(() => {
    if (!activeSurfaceId) return;
    const column = columnRefs.current.get(activeSurfaceId);
    if (!column) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    column.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [activeSurfaceId, revealRequestId]);

  return (
    <div
      ref={stripRef}
      className="flex min-h-0 flex-1 snap-x snap-proximity overflow-x-auto overflow-y-hidden"
      data-right-panel-columns
    >
      {surfaces.map((surface) => {
        const active = surface.id === activeSurfaceId;
        return (
          <div
            key={surface.id}
            ref={(element) => {
              if (element) columnRefs.current.set(surface.id, element);
              else columnRefs.current.delete(surface.id);
            }}
            data-right-panel-column={surface.id}
            data-active-column={active}
            className={cn(
              // One surface fills the panel; more share it in halves, never
              // narrower than a usable column, and scroll past the edge.
              "relative flex min-h-0 shrink-0 snap-start flex-col border-l border-border first:border-l-0",
              surfaces.length === 1 ? "w-full" : "w-[max(50%,min(100%,26rem))]",
            )}
            onPointerDownCapture={() => {
              if (!active) onActivate(surface);
            }}
          >
            {surfaces.length > 1 ? (
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5",
                  active ? "bg-primary" : "bg-transparent",
                )}
              />
            ) : null}
            {renderSurface(surface, {
              active,
              visible: visibility.has(surface.id),
              unclipped: visibility.get(surface.id) === "full",
            })}
          </div>
        );
      })}
    </div>
  );
}
