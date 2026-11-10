import { observeResize } from "~/lib/observeResize";

const USER_SCROLL_INTENT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Keeps a linked node `offset()` below the scroller's top while the content around it opens and
 * its markdown loads, until the user scrolls, the node leaves, or the returned stop runs. Only the
 * scroller moves; scrollIntoView would also scroll the panel's clipped ancestors.
 */
export function holdLinkedNodeInView(
  node: HTMLElement,
  scroller: HTMLElement,
  offset: () => number,
): () => void {
  const controller = new AbortController();
  const stop = () => {
    unobserve();
    controller.abort();
  };
  const align = () => {
    if (!node.isConnected) return stop();
    scroller.scrollTop +=
      node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset();
  };
  const unobserve = observeResize([...scroller.children], align);
  for (const type of USER_SCROLL_INTENT) {
    scroller.addEventListener(type, stop, { passive: true, signal: controller.signal });
  }
  align();
  // Activity can load after the click; by then the user may be typing elsewhere.
  const active = document.activeElement;
  if (
    !(active instanceof HTMLElement) ||
    !(active.isContentEditable || active.matches("input, textarea, select"))
  ) {
    node.focus({ preventScroll: true });
  }
  return stop;
}
