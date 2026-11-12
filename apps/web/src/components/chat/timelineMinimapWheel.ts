const MOUSE_WHEEL_SCROLL_MS = 150;
const PRECISE_WHEEL_DELTA_RATIOS = [1, 3];

interface WheelGlide {
  from: number;
  to: number;
  start: number;
  written: number;
  frame: number;
  interruptions: AbortController;
}

const glides = new WeakMap<HTMLElement, WheelGlide>();

function isPreciseWheel(event: WheelEvent): boolean {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return false;
  const { wheelDeltaY } = event as WheelEvent & { wheelDeltaY?: number };
  return (
    wheelDeltaY === undefined ||
    PRECISE_WHEEL_DELTA_RATIOS.some((ratio) => Math.abs(wheelDeltaY + ratio * event.deltaY) < 1)
  );
}

function stopGlide(timeline: HTMLElement): WheelGlide | undefined {
  const glide = glides.get(timeline);
  if (!glide) return undefined;
  cancelAnimationFrame(glide.frame);
  glide.interruptions.abort();
  glides.delete(timeline);
  return glide;
}

function glideBy(timeline: HTMLElement, distance: number): void {
  const current = stopGlide(timeline);
  const scrollTop = timeline.scrollTop;
  const base = current ? current.to + scrollTop - current.written : scrollTop;
  const maxScrollTop = timeline.scrollHeight - timeline.clientHeight;
  const glide: WheelGlide = {
    from: scrollTop,
    to: Math.max(0, Math.min(maxScrollTop, base + distance)),
    start: performance.now(),
    written: scrollTop,
    frame: 0,
    interruptions: new AbortController(),
  };
  for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, () => stopGlide(timeline), {
      capture: true,
      signal: glide.interruptions.signal,
    });
  }
  const step = (time: number) => {
    if (!timeline.isConnected) {
      stopGlide(timeline);
      return;
    }
    const drift = timeline.scrollTop - glide.written;
    glide.from += drift;
    glide.to += drift;
    const progress = Math.min(1, Math.max(0, (time - glide.start) / MOUSE_WHEEL_SCROLL_MS));
    timeline.scrollTop = glide.from + (glide.to - glide.from) * (1 - (1 - progress) ** 3);
    glide.written = timeline.scrollTop;
    if (progress < 1) {
      glide.frame = requestAnimationFrame(step);
    } else {
      stopGlide(timeline);
    }
  };
  glide.frame = requestAnimationFrame(step);
  glides.set(timeline, glide);
}

export function forwardWheelToTimeline(event: WheelEvent, timeline: HTMLElement): void {
  if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return;
  event.preventDefault();

  const forwarded = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    altKey: event.altKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });
  if (!timeline.dispatchEvent(forwarded)) return;

  const pixelsPerUnit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? timeline.clientHeight
        : 1;
  const distance = event.deltaY * pixelsPerUnit;
  if (isPreciseWheel(event) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    stopGlide(timeline);
    timeline.scrollBy({ top: distance });
    return;
  }
  glideBy(timeline, distance);
}
