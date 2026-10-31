import { type RefObject, useEffect } from "react";
import { observeResize } from "~/lib/observeResize";

/**
 * Keeps a scrolling tab strip's active tab (`[data-active-tab='true']`) in
 * view: when it changes, and when it or the strip resizes afterwards (a
 * breadcrumb widens the tab, scroll arrows narrow the strip). Only the
 * strip's own viewport scrolls, clear of its scroll fade.
 */
export function useRevealActiveTab(
  stripRef: RefObject<HTMLElement | null>,
  activeKey: string | null,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reveal the active tab when its measured viewport or tab bounds change.
  useEffect(() => {
    if (activeKey === null) return;
    const strip = stripRef.current;
    const viewport = strip?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const tab = strip?.querySelector<HTMLElement>("[data-active-tab='true']");
    if (!viewport || !tab || typeof ResizeObserver === "undefined") return;

    const reveal = () => {
      const fade = Number.parseFloat(getComputedStyle(viewport).scrollPaddingInlineStart) || 0;
      const bounds = viewport.getBoundingClientRect();
      const rect = tab.getBoundingClientRect();
      // A tab too wide to clear both fades fits the strip's edges instead;
      // at either end of the strip that edge's fade is gone.
      const padding = rect.width + 2 * fade <= bounds.width ? fade : 0;
      const left = rect.left - (bounds.left + padding);
      const right = rect.right - (bounds.right - padding);
      // A tab wider than the strip keeps its start in view.
      if (left < 0) viewport.scrollLeft += left;
      else if (right > 0) viewport.scrollLeft += Math.min(left, right);
    };
    return observeResize([viewport, tab], reveal);
  }, [stripRef, activeKey]);
}
