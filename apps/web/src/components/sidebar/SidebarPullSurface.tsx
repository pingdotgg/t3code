import { useEffect, useRef, type ReactNode } from "react";

/** Keeps fixed list controls attached to the rows during a top-edge overscroll. */
export function SidebarPullSurface({
  header,
  footer,
  children,
}: {
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const surface = surfaceRef.current;
    if (!root || !surface) return;

    let distance = 0;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let touch: { x: number; y: number } | undefined;
    const viewport = () => surface.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const atTop = () => (viewport()?.scrollTop ?? 0) <= 0;
    const hasArtwork = () => root.querySelector(".sidebar-stage-backdrop") !== null;
    const setDistance = (next: number) => {
      distance = Math.max(0, Math.min(next, 720));
      root.dataset.pulling = String(distance > 0);
      root.style.setProperty("--sidebar-pull-offset", `${224 * (1 - Math.exp(-distance / 240))}px`);
    };
    const release = () => {
      clearTimeout(releaseTimer);
      setDistance(0);
      touch = undefined;
    };
    const onWheel = (event: WheelEvent) => {
      if (
        !hasArtwork() ||
        event.ctrlKey ||
        event.shiftKey ||
        event.buttons !== 0 ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        !event.cancelable
      )
        return;
      // Leave normal scrolling and nested menus alone. Controls above the viewport
      // share its top boundary, so the pull can start over search or the filter.
      const targetViewport =
        event.target instanceof Element
          ? event.target.closest('[data-slot="scroll-area-viewport"]')
          : null;
      if (targetViewport && targetViewport !== viewport()) return;
      if (!atTop() || (distance === 0 && event.deltaY >= 0)) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1;
      setDistance(distance - event.deltaY * unit);
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(release, 120);
    };
    const onTouchStart = (event: TouchEvent) => {
      release();
      const first = event.touches[0];
      if (event.touches.length === 1 && first && atTop() && hasArtwork()) {
        touch = { x: first.clientX, y: first.clientY };
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      const first = event.touches[0];
      if (!touch || !first) return;
      if (event.touches.length !== 1 || !atTop()) {
        release();
        return;
      }
      const dy = first.clientY - touch.y;
      if (distance === 0 && (dy <= 0 || Math.abs(first.clientX - touch.x) > dy)) {
        touch = undefined;
        return;
      }
      if (!event.cancelable) {
        release();
        return;
      }
      event.preventDefault();
      setDistance(dy);
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("touchstart", onTouchStart, { passive: true });
    surface.addEventListener("touchmove", onTouchMove, { passive: false });
    surface.addEventListener("touchend", release);
    surface.addEventListener("touchcancel", release);
    surface.addEventListener("dragstart", release);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      release();
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("touchstart", onTouchStart);
      surface.removeEventListener("touchmove", onTouchMove);
      surface.removeEventListener("touchend", release);
      surface.removeEventListener("touchcancel", release);
      surface.removeEventListener("dragstart", release);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, []);

  return (
    <>
      <div ref={rootRef} className="sidebar-pull-root flex min-h-0 flex-1 flex-col overflow-hidden">
        {header}
        <div ref={surfaceRef} className="sidebar-pull-surface flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </div>
      {footer}
    </>
  );
}
