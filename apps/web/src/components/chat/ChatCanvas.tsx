import { useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { useStore } from "zustand";
import { ChatCanvasContext } from "./ChatCanvasContext";
import type { ChatCanvasPreview } from "./chatCanvasLayout";
import { resolveChatCanvasModel, type ChatCanvasStore } from "./canvasStore";
import {
  selectThreadPanelOpen,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { observeResize } from "../../lib/observeResize";
import { usePanelAnimationSettings } from "../../panelAnimations";
import type { ScopedThreadRef } from "@t3tools/contracts";

export function ChatCanvas({
  store,
  threadRef,
  preview,
  composerOverlayElement,
  detailsCardTopInset = 0,
  children,
  ...props
}: Omit<ComponentProps<"div">, "className" | "style" | "ref"> & {
  store: ChatCanvasStore;
  /** The thread whose details card sits on the canvas; other threads' measurements are stale. */
  threadRef: ScopedThreadRef | null;
  /** The thread's mini player while it renders on this canvas. */
  preview: ChatCanvasPreview | null;
  composerOverlayElement: HTMLElement | null;
  detailsCardTopInset?: number;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const widthProbeRef = useRef<HTMLDivElement | null>(null);
  const [timelineElement, registerTimeline] = useState<HTMLElement | null>(null);
  const measurements = useStore(store, (state) => state.measurements);
  const rightPanelOpen = useRightPanelStore((state) =>
    threadRef === null ? false : selectThreadRightPanelState(state.byThreadKey, threadRef).isOpen,
  );
  const detailsCardMeasurement = useStore(store, (state) => state.detailsCardMeasurement);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes canvas, find bar and timeline resizes and writes the measurements to the canvas store
  useLayoutEffect(() => {
    const element = elementRef.current;
    const probe = widthProbeRef.current;
    if (!element || !probe) return;
    const findBar =
      detailsCardTopInset > 0 ? element.querySelector<HTMLElement>("[data-thread-find-bar]") : null;
    const measure = () => {
      const canvasBounds = element.getBoundingClientRect();
      const findBarBounds = findBar?.getBoundingClientRect();
      const styles = getComputedStyle(probe);
      const pendingWidthChange = pendingSiblingWidthChange(element);
      store.getState().setMeasurements({
        // Exact widths, rounded once: the canvas and the panel always sum to the same width,
        // so the settled width holds still while they trade space.
        settledWidth:
          pendingWidthChange === 0
            ? element.clientWidth
            : Math.round(canvasBounds.width + pendingWidthChange),
        findBar:
          detailsCardTopInset > 0
            ? {
                left: findBarBounds ? findBarBounds.left - canvasBounds.left : 0,
                right: findBarBounds ? findBarBounds.right - canvasBounds.left : 0,
                bottom: findBarBounds ? findBarBounds.bottom - canvasBounds.top : 0,
              }
            : null,
        width: element.clientWidth,
        height: element.clientHeight,
        padding: Number.parseFloat(styles.paddingLeft),
        maxChatWidth: Number.parseFloat(styles.width),
        minChatWidth: Number.parseFloat(styles.minWidth),
        composerHeight: composerOverlayElement?.getBoundingClientRect().height ?? 0,
        timelineGutter: timelineElement
          ? (timelineElement.offsetWidth - timelineElement.clientWidth) / 2
          : 0,
      });
    };
    measure();
    const observed: Element[] = [element, probe];
    if (findBar) observed.push(findBar);
    if (composerOverlayElement) observed.push(composerOverlayElement);
    if (timelineElement) observed.push(timelineElement);
    return observeResize(observed, measure);
    // Re-measures as the right panel toggles, before its first animated frame resizes the canvas.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- rightPanelOpen only triggers that measure
  }, [store, composerOverlayElement, timelineElement, detailsCardTopInset, rightPanelOpen]);
  const detailsCardInlineOpen = useRightPanelStore((state) =>
    threadRef === null
      ? false
      : selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const model = resolveChatCanvasModel({
    measurements,
    detailsCardMeasurement,
    threadRef,
    preview,
    detailsCardInlineOpen,
  });
  const context = {
    container: model.container,
    lane: model.lane,
    layout: model.layout,
    previewKey: preview?.key ?? null,
    registerTimeline,
    measureDetailsCard: store.getState().measureDetailsCard,
    detailsCardTopInset: model.detailsCardTopInset,
    preferredDetailsCard: model.preferredDetailsCard,
    detailsCardPlacement: model.detailsCardPlacement,
    canvasSettling: model.canvasSettling,
    detailsCardLaneShift: model.detailsCardLaneShift,
  };
  const { layout } = context;
  const { active: animationsActive, durationMs } = usePanelAnimationSettings();
  // Ease when the card starts or stops claiming space, and when a panel animation
  // moves the space it claims to where the canvas settles.
  const laneClaim = model.laneAvoidsDetailsCard
    ? model.canvasSettling
      ? "settling"
      : "settled"
    : null;
  const laneRef = useRef({
    claim: laneClaim,
    start: layout.chat.insetStart,
    end: layout.chat.insetEnd,
    from: { start: 0, end: 0 },
    animation: null as Animation | null,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- eases the lane's CSS insets with the Web Animations API when the details card starts or stops claiming space
  useLayoutEffect(() => {
    const previous = laneRef.current;
    laneRef.current = {
      ...previous,
      claim: laneClaim,
      start: layout.chat.insetStart,
      end: layout.chat.insetEnd,
    };
    if (!animationsActive) {
      previous.animation?.cancel();
      return;
    }
    if (previous.claim === laneClaim) return;
    // Settling ends on the live insets, so there is nothing to ease.
    if (previous.claim === "settling" && laneClaim === "settled") return;
    // A reversal mid-ease starts from the visible insets, not the last target.
    const progress = previous.animation?.effect?.getComputedTiming().progress ?? 1;
    const from = {
      start: previous.from.start + (previous.start - previous.from.start) * progress,
      end: previous.from.end + (previous.end - previous.from.end) * progress,
    };
    // With no jump to hide, an ease would only lag the live insets and overshoot.
    if (
      Math.abs(from.start - layout.chat.insetStart) < 1 &&
      Math.abs(from.end - layout.chat.insetEnd) < 1
    ) {
      return;
    }
    previous.animation?.cancel();
    // One keyframe: the animation ends on the live insets even while the canvas resizes.
    const animation =
      elementRef.current?.animate(
        [
          {
            offset: 0,
            "--chat-lane-inset-start": `${from.start}px`,
            "--chat-lane-inset-end": `${from.end}px`,
          },
        ],
        // Tailwind's ease-out, which the panels and the details card use.
        {
          duration: durationMs,
          easing:
            getComputedStyle(elementRef.current).getPropertyValue("--ease-out").trim() ||
            "ease-out",
        },
      ) ?? null;
    laneRef.current = { ...laneRef.current, from, animation };
  }, [animationsActive, durationMs, laneClaim, layout.chat.insetStart, layout.chat.insetEnd]);
  return (
    <ChatCanvasContext value={context}>
      <div
        {...props}
        ref={elementRef}
        data-chat-canvas
        data-preview-overlaps-chat={layout.overlapsChat || undefined}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={
          {
            "--chat-timeline-gutter": `${measurements.timelineGutter}px`,
            "--chat-lane-inset-start": `${layout.chat.insetStart}px`,
            "--chat-lane-inset-end": `${layout.chat.insetEnd}px`,
          } as CSSProperties
        }
      >
        <div
          ref={widthProbeRef}
          aria-hidden
          className="pointer-events-none invisible absolute h-0 w-(--chat-content-max-width) min-w-[40rem] box-content ps-3 sm:ps-12"
        />
        {children}
      </div>
    </ChatCanvasContext>
  );
}

/** How much the chat column's siblings, such as the right panel, still have to resize. */
function pendingSiblingWidthChange(canvas: HTMLElement) {
  const column = canvas.closest("[data-chat-column]");
  let change = 0;
  for (const sibling of column?.parentElement?.children ?? []) {
    if (sibling === column) continue;
    for (const animation of sibling.getAnimations()) {
      if (!(animation instanceof CSSTransition) || animation.transitionProperty !== "width")
        continue;
      if (!(animation.effect instanceof KeyframeEffect)) continue;
      const end = Number.parseFloat(String(animation.effect.getKeyframes().at(-1)?.width));
      if (Number.isFinite(end)) change += sibling.getBoundingClientRect().width - end;
    }
  }
  return change;
}
