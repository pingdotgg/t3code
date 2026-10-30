import { resolveTimelineMinimapPreview, type TimelineMinimapItem } from "./timelineMinimapItems";
import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type Ref,
} from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapNavigationInteractive,
  resolveTimelineMinimapTopPercent,
  TIMELINE_MINIMAP_MIN_ITEMS,
} from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { useStableCallback } from "~/hooks/useStableCallback";
import { resolveTimelineMinimapMarkers } from "./timelineMinimapRail";
import { observeResize } from "~/lib/observeResize";

interface CanvasWidthTransition {
  width: number;
  from: number;
  to: number;
  started: number;
}

interface CanvasRail {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  base: HTMLCanvasElement;
  baseContext: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  padding: number;
  count: number;
  activeIndex: number | null;
  widths: Map<number, CanvasWidthTransition>;
  frame: number | null;
  reducedMotion: boolean;
  contextLost: boolean;
  baseColor: string;
  activeColor: string;
  highlightColor: string;
  paintedStart: number | null;
  paintedEnd: number | null;
}

function canvasMarkerWidth(index: number, activeIndex: number | null) {
  const distance = activeIndex === null ? null : Math.abs(index - activeIndex);
  return distance === 0 ? 24 : distance === 1 ? 16 : distance === 2 ? 10 : 8;
}

// Invert the x coordinate of CSS cubic-bezier(.4, 0, .2, 1).
function canvasWidthEase(progress: number) {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const t = (low + high) / 2;
    const x = 1.2 * (1 - t) * (1 - t) * t + 0.6 * (1 - t) * t * t + t * t * t;
    if (x < progress) low = t;
    else high = t;
  }
  const t = (low + high) / 2;
  return t * t * (3 - 2 * t);
}

function stopCanvasWidthAnimation(rail: CanvasRail) {
  if (rail.frame !== null) cancelAnimationFrame(rail.frame);
  rail.frame = null;
  rail.widths.clear();
}

function retargetCanvasWidths(rail: CanvasRail, activeIndex: number | null) {
  const started = performance.now();
  const affectedIndices = new Set<number>();
  for (const center of [rail.activeIndex, activeIndex]) {
    if (center === null) continue;
    for (
      let index = Math.max(0, center - 2);
      index <= Math.min(rail.count - 1, center + 2);
      index += 1
    ) {
      affectedIndices.add(index);
    }
  }
  for (const index of affectedIndices) {
    const transition = rail.widths.get(index);
    const width = transition?.width ?? canvasMarkerWidth(index, rail.activeIndex);
    const to = canvasMarkerWidth(index, activeIndex);
    if (width === to) rail.widths.delete(index);
    else if (transition?.to !== to) {
      // Retarget from pixels last painted; unchanged destinations keep their deadline.
      rail.widths.set(index, { width, from: width, to, started });
    }
  }
}

function animateCanvasWidths(rail: CanvasRail) {
  if (rail.frame !== null || rail.widths.size === 0 || rail.contextLost) return;
  rail.frame = requestAnimationFrame((now) => {
    rail.frame = null;
    for (const [index, transition] of rail.widths) {
      const progress = Math.min(1, Math.max(0, (now - transition.started) / 150));
      if (progress === 1) rail.widths.delete(index);
      else {
        transition.width =
          transition.from + (transition.to - transition.from) * canvasWidthEase(progress);
      }
    }
    const start = rail.paintedStart ?? 0;
    const end = rail.paintedEnd ?? 0;
    // Rebuild the compound shapes together so overlapping dense ticks keep their alpha.
    rebuildCanvasRail(rail);
    paintCanvasRail(rail, start, end);
    animateCanvasWidths(rail);
  });
}

// Fill once per layer so overlapping dense markers do not accumulate alpha.
function fillCanvasRail(
  context: CanvasRenderingContext2D,
  rail: CanvasRail,
  start: number,
  end: number,
  excludedIndex: number | null = null,
) {
  const scaleX = rail.padding;
  const height = rail.height - 2 * rail.padding;
  const transform = context.getTransform();
  const radii = { x: 0, y: 0 };
  context.beginPath();
  for (let index = Math.max(0, start); index < Math.min(rail.count, end); index += 1) {
    if (index === excludedIndex) continue;
    const width = rail.widths.get(index)?.width ?? canvasMarkerWidth(index, rail.activeIndex);
    const y = rail.padding + (resolveTimelineMinimapTopPercent(index, rail.count) / 100) * height;
    // Snap marker edges to device pixels to keep thin bodies sharp.
    const top =
      (Math.round((y - rail.padding) * transform.d + transform.f) - transform.f) / transform.d;
    const bottom =
      (Math.round((y + rail.padding) * transform.d + transform.f) - transform.f) / transform.d;
    radii.x = (width / 24) * scaleX;
    radii.y = (bottom - top) / 2;
    context.roundRect(rail.padding, top, width * scaleX, bottom - top, radii);
  }
  context.fill();
  // Do not retain a count-sized current path between paints.
  context.beginPath();
}

function rebuildCanvasRail(rail: CanvasRail) {
  const context = rail.baseContext;
  rail.paintedStart = null;
  rail.paintedEnd = null;
  context.save();
  context.resetTransform();
  context.clearRect(0, 0, rail.base.width, rail.base.height);
  context.restore();
  if (rail.width <= 2 * rail.padding || rail.height <= 2 * rail.padding) return;
  context.fillStyle = rail.baseColor;
  fillCanvasRail(context, rail, 0, rail.count, rail.activeIndex);
  if (rail.activeIndex !== null) {
    context.fillStyle = rail.activeColor;
    fillCanvasRail(context, rail, rail.activeIndex, rail.activeIndex + 1);
  }
}

function paintCanvasRail(rail: CanvasRail, start: number, end: number) {
  if (rail.contextLost || (rail.paintedStart === start && rail.paintedEnd === end)) return;
  const context = rail.context;
  // The synchronous theme inspector reads these semantic paint dependencies.
  rail.canvas.style.fill = start < end ? "" : "none";
  context.save();
  context.resetTransform();
  context.clearRect(0, 0, rail.canvas.width, rail.canvas.height);
  const drawable = rail.width > 2 * rail.padding && rail.height > 2 * rail.padding;
  // Copy device pixels directly; the logical transform includes a fractional-origin offset.
  if (drawable) context.drawImage(rail.base, 0, 0);
  context.restore();
  if (drawable) {
    context.fillStyle = rail.highlightColor;
    fillCanvasRail(context, rail, start, end);
  }
  rail.paintedStart = start;
  rail.paintedEnd = end;
}

export interface TimelineMinimapHandle {
  updateVisibleRange: (start: number | null, end: number | null) => void;
}

function timelineMinimapEventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null;
}

// A release outside the window can skip `mouseup`, so the next button-free
// `mousemove` also counts.
function onMouseButtonsReleased(onRelease: () => void): () => void {
  const check = (event: globalThis.MouseEvent) => {
    if (event.buttons !== 0) return;
    stop();
    onRelease();
  };
  const stop = () => {
    window.removeEventListener("mouseup", check);
    window.removeEventListener("mousemove", check);
  };
  window.addEventListener("mouseup", check);
  window.addEventListener("mousemove", check);
  return stop;
}

export function TimelineMinimap({
  ref,
  hasPersistentGutter,
  hitStripWidth,
  items,
  onWheel,
  onSelect,
}: {
  ref: Ref<TimelineMinimapHandle>;
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  items: ReadonlyArray<TimelineMinimapItem>;
  onWheel: (event: WheelEvent) => void;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeColorRef = useRef<HTMLSpanElement>(null);
  const highlightColorRef = useRef<HTMLSpanElement>(null);
  const canvasRailRef = useRef<CanvasRail | null>(null);
  const measureRailRef = useRef<(() => void) | null>(null);
  const visibleRowsRef = useRef<{ start: number | null; end: number | null }>({
    start: null,
    end: null,
  });
  const rowIndices = items.map((item) => item.rowIndex);
  const wheelTargetRef = (node: HTMLDivElement | null) => {
    minimapRef.current = node;
    if (!node) return;
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
      if (minimapRef.current === node) minimapRef.current = null;
    };
  };

  const pressedOnStripRef = useRef(false);
  const [passThrough, setPassThrough] = useState(false);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const updateVisibleRange = useStableCallback((start: number | null, end: number | null) => {
    visibleRowsRef.current = { start, end };
    const markers = resolveTimelineMinimapMarkers(rowIndices, start, end);
    const rail = canvasRailRef.current;
    if (rail) {
      paintCanvasRail(rail, markers.start, markers.end);
    }
    setCurrentIndex(markers.currentIndex);
  });
  useImperativeHandle(ref, () => ({ updateVisibleRange }), [updateVisibleRange]);
  const refreshCanvasRail = useStableCallback((animate = false) => {
    const rail = canvasRailRef.current;
    if (!rail) return;
    if (
      animate &&
      !rail.reducedMotion &&
      !rail.contextLost &&
      rail.width > 2 * rail.padding &&
      rail.height > 2 * rail.padding &&
      rail.count === items.length
    ) {
      if (rail.activeIndex !== resolvedActiveIndex) retargetCanvasWidths(rail, resolvedActiveIndex);
    } else {
      stopCanvasWidthAnimation(rail);
    }
    rail.count = items.length;
    rail.activeIndex = resolvedActiveIndex;
    if (rail.contextLost) return;
    rebuildCanvasRail(rail);
    updateVisibleRange(visibleRowsRef.current.start, visibleRowsRef.current.end);
    animateCanvasWidths(rail);
  });
  const railMounted = items.length >= TIMELINE_MINIMAP_MIN_ITEMS;
  // oxlint-disable-next-line t3code/react-effect-budget -- Canvas resources and browser observers attach after DOM refs commit and must dispose together.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const activeProbe = activeColorRef.current;
    const highlightProbe = highlightColorRef.current;
    const minimap = minimapRef.current;
    if (!railMounted || !canvas || !activeProbe || !highlightProbe || !minimap) return;
    const railElement = canvas.parentElement!;
    const base = document.createElement("canvas");
    // This is a CPU-backing preference, not a guarantee about Chromium's backend.
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const baseContext = base.getContext("2d", { willReadFrequently: true });
    if (!context || !baseContext) return;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const rail: CanvasRail = {
      canvas,
      context,
      base,
      baseContext,
      width: 0,
      height: 0,
      dpr: 0,
      padding: 1,
      count: 0,
      activeIndex: null,
      widths: new Map(),
      frame: null,
      reducedMotion: motionQuery.matches,
      contextLost: false,
      baseColor: getComputedStyle(canvas).stroke,
      activeColor: getComputedStyle(activeProbe).stroke,
      highlightColor: getComputedStyle(highlightProbe).stroke,
      paintedStart: null,
      paintedEnd: null,
    };
    canvasRailRef.current = rail;
    let previousOffsetX = Number.NaN;
    let previousOffsetY = Number.NaN;
    const measure = () => {
      const bounds = railElement.getBoundingClientRect();
      // w-6 and h-0.5 scale together with the interface font size.
      const padding = bounds.width / 24;
      const width = bounds.width > 0 ? bounds.width + 2 * padding : 0;
      const height = bounds.height > 0 ? bounds.height + 2 * padding : 0;
      const dpr = window.devicePixelRatio || 1;
      // Keep the backing on device pixels without moving the logical marker centers.
      const offsetX = bounds.left - padding - Math.floor((bounds.left - padding) * dpr) / dpr;
      const offsetY = bounds.top - padding - Math.floor((bounds.top - padding) * dpr) / dpr;
      if (
        rail.width === width &&
        rail.height === height &&
        rail.dpr === dpr &&
        previousOffsetX === offsetX &&
        previousOffsetY === offsetY
      )
        return;
      previousOffsetX = offsetX;
      previousOffsetY = offsetY;
      stopCanvasWidthAnimation(rail);
      rail.width = width;
      rail.height = height;
      rail.dpr = dpr;
      rail.padding = padding;
      const backingWidth = Math.max(0, width > 0 ? Math.ceil((width + offsetX) * dpr) : 0);
      const backingHeight = Math.max(0, height > 0 ? Math.ceil((height + offsetY) * dpr) : 0);
      canvas.style.width = `${backingWidth / dpr}px`;
      canvas.style.height = `${backingHeight / dpr}px`;
      canvas.style.left = `${-padding - offsetX}px`;
      canvas.style.top = `${-padding - offsetY}px`;
      for (const target of [canvas, base]) {
        if (target.width !== backingWidth) target.width = backingWidth;
        if (target.height !== backingHeight) target.height = backingHeight;
      }
      for (const target of [context, baseContext]) {
        target.setTransform(dpr, 0, 0, dpr, offsetX * dpr, offsetY * dpr);
      }
      refreshCanvasRail();
    };
    measureRailRef.current = measure;
    const lostBackings = new Set<EventTarget | null>();
    const loseContext = (event: Event) => {
      lostBackings.add(event.currentTarget);
      rail.contextLost = true;
      stopCanvasWidthAnimation(rail);
    };
    const restore = (event: Event) => {
      lostBackings.delete(event.currentTarget);
      if (lostBackings.size > 0) return;
      rail.contextLost = false;
      // Context restoration resets drawing state even when the CSS box is equal.
      rail.dpr = 0;
      measure();
    };
    const onMotionChange = () => {
      rail.reducedMotion = motionQuery.matches;
      refreshCanvasRail();
    };
    motionQuery.addEventListener("change", onMotionChange);
    canvas.addEventListener("contextlost", loseContext);
    base.addEventListener("contextlost", loseContext);
    canvas.addEventListener("contextrestored", restore);
    base.addEventListener("contextrestored", restore);
    // Timeline resizing also moves this fixed-width rail during sidebar drags.
    const stopObserving = observeResize([railElement, minimap.parentElement!], measure);
    // Palette edits, previews and contrast updates can keep the same light/dark
    // hook value. Observe the root attributes that the existing theme code writes.
    const themeObserver = new MutationObserver(() => {
      const baseColor = getComputedStyle(canvas).stroke;
      const activeColor = getComputedStyle(activeProbe).stroke;
      const highlightColor = getComputedStyle(highlightProbe).stroke;
      if (
        rail.baseColor === baseColor &&
        rail.activeColor === activeColor &&
        rail.highlightColor === highlightColor
      )
        return;
      rail.baseColor = baseColor;
      rail.activeColor = activeColor;
      rail.highlightColor = highlightColor;
      refreshCanvasRail();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme-id"],
    });
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => {
      dprQuery?.removeEventListener("change", onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener("change", onDprChange);
      measure();
    };
    onDprChange();
    window.addEventListener("resize", measure);
    return () => {
      stopCanvasWidthAnimation(rail);
      motionQuery.removeEventListener("change", onMotionChange);
      canvas.removeEventListener("contextlost", loseContext);
      base.removeEventListener("contextlost", loseContext);
      canvas.removeEventListener("contextrestored", restore);
      base.removeEventListener("contextrestored", restore);
      stopObserving();
      themeObserver.disconnect();
      dprQuery?.removeEventListener("change", onDprChange);
      window.removeEventListener("resize", measure);
      if (canvasRailRef.current === rail) canvasRailRef.current = null;
      if (measureRailRef.current === measure) measureRailRef.current = null;
      canvas.width = canvas.height = base.width = base.height = 0;
    };
  }, [railMounted, refreshCanvasRail]);
  // oxlint-disable-next-line t3code/react-effect-budget -- Canvas pixels must match committed props before paint; drawing during render would mutate the previous commit.
  useLayoutEffect(() => {
    // Count changes can resize the logical rail before ResizeObserver delivers.
    if (canvasRailRef.current?.count !== items.length) measureRailRef.current?.();
    // The stable callback refs have committed before this effect redraws widths.
    refreshCanvasRail(true);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Stable callback reads current data; count and active index changes must rebuild the rail.
  }, [items.length, resolvedActiveIndex, refreshCanvasRail]);
  // oxlint-disable-next-line t3code/react-effect-budget -- Reapply the retained viewport range after row mappings commit, including same-count replacements.
  useLayoutEffect(() => {
    updateVisibleRange(visibleRowsRef.current.start, visibleRowsRef.current.end);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Stable callback reads the current mapping; new row indices must refresh the retained range.
  }, [rowIndices, updateVisibleRange]);
  const previewItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  const activeItem = resolveTimelineMinimapPreview(previewItem);
  const navigationInteractive =
    resolveTimelineMinimapNavigationInteractive(hitStripWidth) && !passThrough;
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";
  const resolvedCurrentIndex =
    currentIndex !== null && currentIndex >= 0 && currentIndex < items.length ? currentIndex : null;
  const previousItem =
    resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex - 1] ?? null);
  const nextItem = resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex + 1] ?? null);

  const resolveActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return resolveTimelineMinimapIndexFromPointer({
      itemCount: items.length,
      railTop: rect.top,
      railHeight: rect.height,
      pointerY: event.clientY,
    });
  };

  const updateActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const nextIndex = resolveActiveIndexFromPointer(event);
    setActiveIndex(nextIndex);
  };

  const moveActiveIndex = (delta: number) => {
    setActiveIndex((current) => {
      const base = current ?? 0;
      return Math.max(0, Math.min(items.length - 1, base + delta));
    });
  };

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      ref={wheelTargetRef}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2",
            hitStripWidth > 0 && !passThrough ? "pointer-events-auto" : "pointer-events-none",
          )}
          onMouseDown={() => {
            if (pressedOnStripRef.current) return;
            pressedOnStripRef.current = true;
            onMouseButtonsReleased(() => {
              pressedOnStripRef.current = false;
            });
          }}
          onMouseMove={(event) => {
            if (event.buttons === 0 || pressedOnStripRef.current || passThrough) return;
            setPassThrough(true);
            onMouseButtonsReleased(() => setPassThrough(false));
          }}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: resolveTimelineMinimapInteractiveWidth(hitStripWidth, activeItem !== null),
          }}
        >
          <TimelineMinimapNavigationButton
            direction="previous"
            disabled={previousItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (previousItem) onSelect(previousItem);
            }}
          />
          <button
            aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
            className="absolute inset-y-0 left-0 w-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            onBlur={() => setActiveIndex(null)}
            onClick={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              const nextIndex = resolveActiveIndexFromPointer(event);
              const selectedItem = nextIndex === null ? null : (items[nextIndex] ?? null);
              if (selectedItem) {
                onSelect(selectedItem);
              }
              event.currentTarget.blur();
            }}
            onFocus={() => setActiveIndex((current) => current ?? resolvedCurrentIndex ?? 0)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActiveIndex(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActiveIndex(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(items.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (activeItem) {
                  onSelect(activeItem);
                }
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={(event) => {
              if (event.buttons !== 0 && !pressedOnStripRef.current) return;
              updateActiveIndexFromPointer(event);
            }}
            onMouseDown={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              event.preventDefault();
            }}
            type="button"
          >
            <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 h-full w-6 overflow-visible"
            >
              <canvas
                className="absolute -top-px -left-px h-[calc(100%+2px)] w-[calc(100%+2px)] stroke-muted-foreground/25 fill-foreground/55"
                data-theme-canvas-paint
                data-minimap-canvas
                ref={canvasRef}
                style={{ fill: "none" }}
              />
              <span className="hidden stroke-muted-foreground/60" ref={activeColorRef} />
              <span className="hidden stroke-foreground/55" ref={highlightColorRef} />
            </span>
            {activeItem ? (
              <span
                className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
                data-minimap-preview
                onMouseMove={(event) => event.stopPropagation()}
                style={{
                  top: `${activeTopPercent}%`,
                  transform: `translateY(${activeTooltipTranslate})`,
                }}
              >
                <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                  <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                    {activeItem.userText ?? "User message"}
                  </span>
                  {activeItem.assistantText ? (
                    <span
                      className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                      style={{
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 3,
                      }}
                    >
                      {activeItem.assistantText}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </button>
          <TimelineMinimapNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) onSelect(nextItem);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function TimelineMinimapNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const Icon = previous ? ChevronUpIcon : ChevronDownIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
              interactive ? "pointer-events-auto" : "pointer-events-none",
              previous ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]",
            )}
          />
        }
      >
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-micro"
          type="button"
          variant="ghost-muted"
        >
          <Icon className="size-4 text-foreground/90" />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side={previous ? "top" : "bottom"}>{label}</TooltipPopup>
    </Tooltip>
  );
}
