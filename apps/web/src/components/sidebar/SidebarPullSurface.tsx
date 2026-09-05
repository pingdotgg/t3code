import { useLayoutEffect, useRef, type ReactNode } from "react";

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

  const scrollRef = useRef<HTMLDivElement>(null);
  const correctionRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const surface = surfaceRef.current;
    const scroller = scrollRef.current;
    const correction = correctionRef.current;
    if (!root || !surface || !scroller || !correction) return;

    let distance = 0;
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
      scroller.scrollTop = 720;
      correction.style.transform = "";
      setDistance(0);
      touch = undefined;
    };
    const listViewport = viewport();
    const previousOverscroll = listViewport?.style.overscrollBehaviorY ?? "";
    if (listViewport) listViewport.style.overscrollBehaviorY = "auto";
    scroller.scrollTop = 720;
    const onScroll = () => {
      if (!hasArtwork() || !atTop()) {
        release();
        return;
      }
      const pulled = 720 - scroller.scrollTop;
      correction.style.transform = `translateY(${-pulled}px)`;
      setDistance(pulled);
    };
    // Native scrolling retains the trackpad gesture lifecycle. An inactivity
    // timer cannot distinguish a stationary finger from a released finger.
    // https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollend_event
    const onScrollEnd = () => {
      if (!touch) release();
    };
    const onWheel = (event: WheelEvent) => {
      const targetViewport =
        event.target instanceof Element
          ? event.target.closest('[data-slot="scroll-area-viewport"]')
          : null;
      if (
        !hasArtwork() ||
        event.ctrlKey ||
        event.shiftKey ||
        event.buttons !== 0 ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        (targetViewport && targetViewport !== viewport())
      ) {
        // Keep these gestures out of the outer pull scroller, while allowing
        // their normal browser/default behavior in the original target.
        scroller.style.overflowY = "hidden";
      } else {
        scroller.style.overflowY = "auto";
      }
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
    scroller.addEventListener("scroll", onScroll);
    scroller.addEventListener("scrollend", onScrollEnd);
    surface.addEventListener("wheel", onWheel, { passive: true });
    surface.addEventListener("touchstart", onTouchStart, { passive: true });
    surface.addEventListener("touchmove", onTouchMove, { passive: false });
    surface.addEventListener("touchend", release);
    surface.addEventListener("touchcancel", release);
    surface.addEventListener("dragstart", release);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      release();
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("scrollend", onScrollEnd);
      if (listViewport) listViewport.style.overscrollBehaviorY = previousOverscroll;
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
        <div
          ref={scrollRef}
          className="sidebar-pull-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div aria-hidden className="h-[720px]" />
          <div ref={correctionRef} className="h-full">
            <div ref={surfaceRef} className="sidebar-pull-surface flex h-full min-h-0 flex-col">
              {children}
            </div>
          </div>
        </div>
      </div>
      {footer}
    </>
  );
}
