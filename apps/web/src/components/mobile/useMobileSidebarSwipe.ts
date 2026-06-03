import { useEffect } from "react";

export const SWIPE_OPEN_MIN_DX = 60;
export const SWIPE_CLOSE_MIN_DX = -60;
export const EDGE_TRIGGER_WIDTH = 32;
export const SWIPE_IGNORE_ATTR = "data-swipe-ignore";

export function resolveSwipeAction(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): "open" | "close" | null {
  const dx = endX - startX;
  const dy = endY - startY;
  if (Math.abs(dy) > Math.abs(dx)) return null;
  if (startX < EDGE_TRIGGER_WIDTH && dx > SWIPE_OPEN_MIN_DX) return "open";
  if (dx < SWIPE_CLOSE_MIN_DX) return "close";
  return null;
}

export function isSwipeIgnoredTarget(target: EventTarget | null | undefined): boolean {
  if (target == null) return false;
  const candidate = target as { closest?: (selector: string) => unknown };
  if (typeof candidate.closest !== "function") return false;
  return candidate.closest(`[${SWIPE_IGNORE_ATTR}="true"]`) !== null;
}

export function useMobileSidebarSwipe(setOpenMobile: (open: boolean) => void): void {
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let ignored = false;

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0]!;
      ignored = isSwipeIgnoredTarget(touch.target);
      if (ignored) return;
      startX = touch.clientX;
      startY = touch.clientY;
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (ignored) {
        ignored = false;
        return;
      }
      const touch = e.changedTouches[0]!;
      const action = resolveSwipeAction(startX, startY, touch.clientX, touch.clientY);
      if (action === "open") setOpenMobile(true);
      else if (action === "close") setOpenMobile(false);
    };

    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchend", handleTouchEnd);
    };
  }, [setOpenMobile]);
}
