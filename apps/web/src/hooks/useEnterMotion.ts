import { useLayoutEffect, useRef } from "react";

const EASE_OUT_SOFT = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Replays a short entrance on an element that stays mounted while its content swaps, such as a
 * route outlet or the active thread. Runs before paint, never on first mount.
 */
export function useEnterMotion(
  element: HTMLElement | null,
  motionKey: string,
  {
    distance = 6,
    durationMs = 260,
  }: {
    /** Pixels to rise from; a function can pick the direction from the previous and next key. */
    distance?: number | ((previous: string, next: string) => number);
    durationMs?: number;
  } = {},
) {
  const previousKey = useRef(motionKey);
  const running = useRef<Animation | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts a Web Animation on the DOM node before the swapped content paints; no React state is written
  useLayoutEffect(() => {
    const previous = previousKey.current;
    // A view that remounts while its content loads plays the entrance once it is back.
    if (previous === motionKey || !element?.animate) return;
    previousKey.current = motionKey;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rise = typeof distance === "function" ? distance(previous, motionKey) : distance;
    // Interrupted motion continues from what is on screen; starting partly visible avoids a blink.
    const interrupted = running.current?.playState === "running";
    const opacity = interrupted ? Number(getComputedStyle(element).opacity) : 0.4;
    const offset = interrupted ? getComputedStyle(element).translate : `0 ${rise}px`;
    running.current?.cancel();
    running.current = element.animate(
      reduced
        ? [{ opacity }, { opacity: 1 }]
        : [
            { opacity, translate: offset === "none" ? "0 0" : offset },
            { opacity: 1, translate: "0 0" },
          ],
      { duration: reduced ? 120 : durationMs, easing: EASE_OUT_SOFT },
    );
  }, [distance, durationMs, element, motionKey]);
}
