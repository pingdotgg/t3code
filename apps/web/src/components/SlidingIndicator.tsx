import { useLayoutEffect, useRef } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

/**
 * A highlight that glides to whichever descendant of its parent matches `selector`, so changing
 * selection reads as one thing moving instead of two things blinking. The parent must be
 * positioned. Nothing moves on first paint, and it hides when nothing matches.
 */
export function SlidingIndicator({
  selector,
  className,
}: {
  readonly selector: string;
  readonly className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows DOM selection attributes that React state in sibling subtrees owns, writing styles before paint
  useLayoutEffect(() => {
    const indicator = ref.current;
    const parent = indicator?.parentElement;
    if (!indicator || !parent) return;
    let settleFrame = 0;

    const update = () => {
      const target = parent.querySelector<HTMLElement>(selector);
      if (!target) {
        indicator.style.opacity = "0";
        delete indicator.dataset.ready;
        return;
      }
      const parentRect = parent.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      const x = rect.left - parentRect.left - parent.clientLeft + parent.scrollLeft;
      const y = rect.top - parentRect.top - parent.clientTop + parent.scrollTop;
      indicator.style.width = `${rect.width}px`;
      indicator.style.height = `${rect.height}px`;
      indicator.style.translate = `${x}px ${y}px`;
      indicator.style.opacity = "1";
      if (indicator.dataset.ready === undefined) {
        cancelAnimationFrame(settleFrame);
        settleFrame = requestAnimationFrame(() => {
          indicator.dataset.ready = "";
        });
      }
    };

    update();
    const mutations = new MutationObserver(update);
    mutations.observe(parent, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-pressed", "aria-current", "aria-selected", "data-active-tab"],
    });
    const stopObserving = observeResize(parent, update);
    return () => {
      cancelAnimationFrame(settleFrame);
      mutations.disconnect();
      stopObserving();
    };
  }, [selector]);

  return (
    <span
      ref={ref}
      aria-hidden
      data-slot="sliding-indicator"
      className={cn("sliding-indicator pointer-events-none absolute top-0 left-0", className)}
    />
  );
}
