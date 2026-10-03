import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverCreateHandle } from "../ui/popover";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { useChatCanvas } from "./ChatCanvasContext";
import {
  recordThreadDetailsContentHeight,
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
  type ThreadDetailsContentMeasurement,
} from "./threadDetailsCardLayout";

/** One card owns its placement and folds content only when that content cannot fit. */
export function ThreadDetailsCard({
  threadRef,
  anchor,
  handle,
  onPresentationChange,
  children,
}: {
  threadRef: ScopedThreadRef;
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
  onPresentationChange: (presentation: ThreadPanelPresentation) => void;
  children: (density: "full" | "compact" | "essential") => ReactNode;
}) {
  const canvas = useChatCanvas();
  const preferredPlacement = canvas
    ? resolveThreadDetailsCardLayout({
        container: canvas.container,
        lane: canvas.lane,
        frame: null,
      })
    : null;
  const placement = canvas
    ? resolveThreadDetailsCardLayout({
        container: canvas.container,
        lane: canvas.lane,
        frame: canvas.layout.frame,
        overlapsDetailsCard: canvas.layout.overlapsDetailsCard,
      })
    : null;
  const mode = placement ? "inline" : "popover";
  const inlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const popoverOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "popover"),
  );
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  const measurementKey = `${threadRef.environmentId}:${threadRef.threadId}:${preferredPlacement?.width ?? "popup"}`;
  const [measurements, setMeasurements] = useState<ThreadDetailsContentMeasurement>({
    key: measurementKey,
    heights: { full: 0, compact: 0 },
    latestFull: 0,
  });
  const measured = measurements.key === measurementKey ? measurements : null;
  // Density follows the stable baselines; the reported footprint follows the
  // latest full height so an expanded card is not underreported as collapsed.
  const contentHeights = measured?.heights ?? { full: 0, compact: 0 };
  const latestFull = measured?.latestFull ?? 0;
  const height = placement?.height ?? Math.max(0, (canvas?.container.height ?? 0) - 52);
  const density = resolveThreadDetailsCardDensity(height, contentHeights);
  const reportDetailsCard = canvas?.reportDetailsCard;
  const cardLeft = preferredPlacement?.x;
  const cardRight = preferredPlacement
    ? preferredPlacement.x + preferredPlacement.width
    : undefined;
  const cardBottom =
    preferredPlacement && latestFull > 0
      ? preferredPlacement.y + Math.min(latestFull, preferredPlacement.height)
      : undefined;
  useLayoutEffect(() => {
    reportDetailsCard?.(
      inlineOpen && cardLeft !== undefined && cardRight !== undefined && cardBottom !== undefined
        ? { left: cardLeft, right: cardRight, bottom: cardBottom }
        : null,
    );
  }, [reportDetailsCard, inlineOpen, cardLeft, cardRight, cardBottom]);
  useLayoutEffect(() => () => reportDetailsCard?.(null), [reportDetailsCard]);
  useLayoutEffect(() => {
    onPresentationChange(mode);
    if (mode === "inline" && popoverOpen)
      useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false);
  }, [mode, onPresentationChange, threadRef, popoverOpen]);
  useLayoutEffect(() => {
    const element = contentElement;
    if (!element || density === "essential") return;
    // Measure the single content tree before the scroll viewport clips it. The
    // reducer keeps a stable per-density baseline so a bounded, scrollable
    // section (Lineage) can expand without folding the card that owns it.
    const measure = () => {
      const frame = element.closest<HTMLElement>("[data-thread-details-card]");
      const next = element.offsetHeight + (frame ? frame.offsetHeight - frame.clientHeight : 0);
      setMeasurements((current) =>
        recordThreadDetailsContentHeight(current, measurementKey, density, next),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [contentElement, density, measurementKey]);
  const card = (
    <div
      className={cn(
        "dropdown-glass isolate contain-paint grid max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden rounded-3xl",
        mode === "popover" &&
          "max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))]",
      )}
      style={placement ? { maxHeight: height } : undefined}
      data-thread-details-card
    >
      <ScrollArea scrollFade className="min-h-0">
        <div ref={setContentElement}>{children(density)}</div>
      </ScrollArea>
    </div>
  );
  return (
    <Popover
      handle={handle}
      open={mode === "popover" && popoverOpen}
      onOpenChange={(open) =>
        useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", open)
      }
    >
      {placement ? (
        inlineOpen ? (
          <aside
            aria-label="Thread details"
            className="absolute z-20"
            style={{
              left: placement.x,
              top: placement.y,
              width: placement.width,
              maxHeight: height,
            }}
            data-density={density}
            data-thread-details-panel="inline"
          >
            {card}
          </aside>
        ) : null
      ) : (
        <PopoverPopup
          anchor={anchor}
          align="end"
          alignOffset={0}
          collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
          side="bottom"
          sideOffset={0}
          variant="panel"
          padding="none"
        >
          <div data-density={density} data-thread-details-panel="popover">
            {card}
          </div>
        </PopoverPopup>
      )}
    </Popover>
  );
}
