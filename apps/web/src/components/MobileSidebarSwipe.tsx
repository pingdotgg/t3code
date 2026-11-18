import { useEffect } from "react";

import { useSidebar } from "./ui/sidebar";

// Fork-only: on a phone, a sideways swipe anywhere opens (right) or closes (left) the sidebar.
const MIN_DISTANCE = 60;
const HORIZONTAL_DOMINANCE = 2;

function blocksSwipe(path: readonly EventTarget[], deltaX: number, opening: boolean): boolean {
  for (const node of path) {
    if (!(node instanceof Element)) continue;
    if (node.matches("input, textarea, [contenteditable='true']")) return true;
    if (opening && node.matches('[role="dialog"]')) return true;
    if (node.scrollWidth <= node.clientWidth) continue;
    const { overflowX } = getComputedStyle(node);
    if (overflowX !== "auto" && overflowX !== "scroll") continue;
    // A swipe right reveals content to the left, so it scrolls while scrollLeft > 0.
    if (
      deltaX > 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1
    )
      return true;
  }
  return false;
}

export function MobileSidebarSwipe() {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document touch listeners while mounted on a phone
  useEffect(() => {
    if (!isMobile) return;
    let start: { x: number; y: number; path: EventTarget[] } | null = null;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start =
        event.touches.length === 1 && touch
          ? { x: touch.clientX, y: touch.clientY, path: event.composedPath() }
          : null;
    };
    const onEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!start || !touch) return;
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      const { path } = start;
      start = null;
      if (Math.abs(deltaX) < MIN_DISTANCE) return;
      if (Math.abs(deltaX) < HORIZONTAL_DOMINANCE * Math.abs(deltaY)) return;
      const opening = deltaX > 0;
      if (opening === openMobile || blocksSwipe(path, deltaX, opening)) return;
      setOpenMobile(opening);
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
    };
  }, [isMobile, openMobile, setOpenMobile]);

  return null;
}
