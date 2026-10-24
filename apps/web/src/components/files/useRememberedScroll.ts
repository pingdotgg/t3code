import { useLayoutEffect, useRef } from "react";

import { observeResize } from "~/lib/observeResize";

const MAX_REMEMBERED_POSITIONS = 100;
const scrollTops = new Map<string, number>();
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

function remember(key: string, scrollTop: number) {
  scrollTops.delete(key);
  if (scrollTop > 0) scrollTops.set(key, scrollTop);
  const oldest = scrollTops.keys().next();
  if (scrollTops.size > MAX_REMEMBERED_POSITIONS && !oldest.done) scrollTops.delete(oldest.value);
}

/**
 * Gives a scrolled surface back its position after it remounts. Attach the
 * returned ref to an element inside the `ScrollArea`.
 *
 * Images and other late content can leave the document too short to reach the
 * saved position when it mounts, so the restore repeats as the content resizes
 * until it lands or the user scrolls. The position is read when the surface
 * unmounts rather than from scroll events. An unfinished restore keeps the
 * remembered position, because the viewport is still clamped short of it, and
 * so does an unmount while the panel is hidden, which reads as zero.
 */
export function useRememberedScroll(key: string) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const content = ref.current;
    const viewport = content?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    // The scrollbar is a sibling of the viewport, so dragging it is only seen from the root.
    const scrollArea = viewport?.parentElement;
    if (!content || !viewport || !scrollArea) return;

    const saved = scrollTops.get(key);
    const takeover = new AbortController();
    let restoring = saved !== undefined;
    let stopObserving = () => {};
    const stop = () => {
      restoring = false;
      stopObserving();
      takeover.abort();
    };
    const restore = () => {
      if (saved === undefined) return;
      viewport.scrollTop = saved;
      // Fractional zoom levels can read a pixel short of the value just set.
      if (viewport.scrollTop >= saved - 1) stop();
    };

    if (saved !== undefined) {
      restore();
      if (restoring) {
        // The viewport shrinking raises the furthest position the document can scroll to, with
        // the content's own size unchanged.
        const stopContent = observeResize(content, restore);
        const stopViewport = observeResize(viewport, restore);
        stopObserving = () => {
          stopContent();
          stopViewport();
        };
        for (const type of USER_SCROLL_EVENTS) {
          scrollArea.addEventListener(type, stop, {
            passive: true,
            capture: true,
            signal: takeover.signal,
          });
        }
      }
    }

    return () => {
      if (!restoring && viewport.clientHeight > 0) remember(key, viewport.scrollTop);
      stop();
    };
  }, [key]);

  return ref;
}
