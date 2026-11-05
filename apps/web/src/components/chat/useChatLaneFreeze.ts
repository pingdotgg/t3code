import { type RefObject, useEffect } from "react";

// Longer than the slowest panel animation setting.
const RELEASE_TIMEOUT_MS = 700;
const SLIDING_NEIGHBORS = '[data-slot="sidebar-gap"], [data-preview-panel-mode]';

function finalWidth(element: Element): number | null {
  const transition = element
    .getAnimations()
    .find((animation) => (animation as CSSTransition).transitionProperty === "width");
  const keyframes =
    transition?.effect instanceof KeyframeEffect ? transition.effect.getKeyframes() : null;
  const width = Number.parseFloat(String(keyframes?.at(-1)?.width));
  return Number.isFinite(width) ? width : null;
}

/**
 * While a neighboring panel slides, holds the chat at the width it will end up with, so text
 * wraps once instead of on every frame. The canvas still shrinks around it, and the chat stays
 * centered in it, which keeps the glide on the compositor for everything but the outer frame.
 */
export function useChatLaneFreeze(
  canvasRef: RefObject<HTMLElement | null>,
  onLayout: (heldWidth?: number) => void,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows CSS transitions on panels owned by other subtrees and writes the held width straight to the DOM; no React state involved
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sliding = new Map<Element, number>();
    let watchdog = 0;
    const release = () => {
      window.clearTimeout(watchdog);
      sliding.clear();
      delete canvas.dataset.laneHeld;
      canvas.style.removeProperty("--chat-held-width");
      onLayout();
    };
    const handleRun = (event: TransitionEvent) => {
      if (event.propertyName !== "width" || !(event.target instanceof Element)) return;
      if (!event.target.matches(SLIDING_NEIGHBORS) || canvas.contains(event.target)) return;
      const final = finalWidth(event.target);
      if (final === null) return;
      sliding.set(event.target, final);
      // Each neighbor only has what is left of its own slide still to give or take.
      let remaining = 0;
      for (const [element, width] of sliding) {
        remaining += width - Number.parseFloat(getComputedStyle(element).width);
      }
      const heldWidth = canvas.clientWidth - remaining;
      canvas.style.setProperty("--chat-held-width", `${heldWidth}px`);
      canvas.dataset.laneHeld = "";
      onLayout(heldWidth);
      // A neighbor removed mid-slide never reports an end, and the lane must not stay held.
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(release, RELEASE_TIMEOUT_MS);
    };
    const handleDone = (event: TransitionEvent) => {
      if (event.propertyName !== "width" || !(event.target instanceof Element)) return;
      if (!sliding.delete(event.target) || sliding.size > 0) return;
      release();
    };
    const ownerDocument = canvas.ownerDocument;
    ownerDocument.addEventListener("transitionrun", handleRun, true);
    ownerDocument.addEventListener("transitionend", handleDone, true);
    ownerDocument.addEventListener("transitioncancel", handleDone, true);
    return () => {
      ownerDocument.removeEventListener("transitionrun", handleRun, true);
      ownerDocument.removeEventListener("transitionend", handleDone, true);
      ownerDocument.removeEventListener("transitioncancel", handleDone, true);
      window.clearTimeout(watchdog);
    };
  }, [canvasRef, onLayout]);
}
