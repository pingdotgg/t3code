import { useEffect, useState, type PointerEvent, type RefObject } from "react";

// Matches the data-peek slide duration on the sidebar container.
const SLIDE_MS = 200;
// The card closes once the pointer is this far past its edge, the same
// distance from the window edge that opens it.
export const PEEK_EDGE_PX = 8;
// Matches the shown card's translate past the window edge, --spacing(2).
const CARD_INSET_PX = 8;

export type SidebarPeek = "hidden" | "shown" | "leaving";

/**
 * Peeks a collapsed offcanvas sidebar as a floating card while the mouse
 * rests on the window's left edge, and slides it back once the mouse moves
 * past it. The container draws the card from its data-peek attribute.
 */
export function useSidebarPeek({
  enabled,
  containerRef,
  onLeave,
}: {
  enabled: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  onLeave: () => void;
}) {
  const [peek, setPeek] = useState<SidebarPeek>("hidden");
  if (peek !== "hidden" && !enabled) setPeek("hidden");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that drops data-peek once the slide-out transition has run
  useEffect(() => {
    if (peek !== "leaving") return;
    const timer = window.setTimeout(() => setPeek("hidden"), SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [peek]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document pointermove listener that hides the card once the pointer leaves it
  useEffect(() => {
    const container = containerRef.current;
    if (peek !== "shown" || !container) return;
    // The offset box ignores the slide transform, so the card's right edge
    // counts from its first frame. Menus opened from the sidebar render in
    // portals outside it, so an open menu or a hovered popup also holds it.
    const holdsPeekOpen = (event: globalThis.PointerEvent) =>
      event.clientX < container.offsetWidth + CARD_INSET_PX + PEEK_EDGE_PX ||
      container.querySelector("[data-popup-open]") !== null ||
      (event.target instanceof Element && event.target.closest('[data-slot$="popup"]') !== null);
    const onPointerMove = (event: globalThis.PointerEvent) => {
      if (holdsPeekOpen(event)) return;
      onLeave();
      setPeek("leaving");
    };
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => document.removeEventListener("pointermove", onPointerMove);
  }, [containerRef, onLeave, peek]);

  const onEdgePointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse") return;
    const container = containerRef.current;
    if (peek === "hidden" && container) {
      // Commit the offscreen start position so the card slides in from it.
      container.dataset.peek = "entering";
      container.getBoundingClientRect();
    }
    setPeek("shown");
  };

  return { peek, onEdgePointerEnter };
}
