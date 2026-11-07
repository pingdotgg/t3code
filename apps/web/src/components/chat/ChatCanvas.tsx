import { useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { useStore } from "zustand";
import { ChatCanvasContext } from "./ChatCanvasContext";
import type { ChatCanvasPreview } from "./chatCanvasLayout";
import { resolveChatCanvasModel, type ChatCanvasStore } from "./canvasStore";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { observeResize } from "../../lib/observeResize";
import type { ScopedThreadRef } from "@t3tools/contracts";

function panelWidthTransitions(element: HTMLElement) {
  const panels = element
    .closest("[data-panel-animations]")
    ?.querySelectorAll('[data-slot="sidebar-gap"], [data-preview-panel-mode="inline"]');
  return Array.from(panels ?? []).flatMap((panel) =>
    panel
      .getAnimations()
      .filter(
        (animation): animation is CSSTransition =>
          animation instanceof CSSTransition &&
          animation.transitionProperty === "width" &&
          animation.playState === "running",
      ),
  );
}

// Sample only the layout panels; seeking unrelated transitions can change their lifecycle.
function measureTransitionWidths(element: HTMLElement, transitions: CSSTransition[]) {
  if (transitions.length === 0) return null;
  const times = transitions.map((animation) => animation.currentTime);
  // Opposite panel transitions can reach their widest points at different times.
  for (const animation of transitions) {
    const end = Number(animation.effect?.getComputedTiming().endTime ?? 0);
    animation.currentTime = 0;
    const startWidth = element.clientWidth;
    animation.currentTime = end;
    if (startWidth < element.clientWidth) animation.currentTime = 0;
  }
  const narrowestWidth = element.clientWidth;
  transitions.forEach((animation, index) => {
    animation.currentTime = times[index] ?? null;
  });
  return { transitions, narrowestWidth };
}

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
  const detailsCardMeasurement = useStore(store, (state) => state.detailsCardMeasurement);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes canvas, find bar and timeline resizes and writes the measurements to the canvas store
  useLayoutEffect(() => {
    const element = elementRef.current;
    const probe = widthProbeRef.current;
    if (!element || !probe) return;
    const findBar =
      detailsCardTopInset > 0 ? element.querySelector<HTMLElement>("[data-thread-find-bar]") : null;
    let disposed = false;
    // Seeking forces layout, so it runs once when a transition starts, not every frame.
    let transitionWidths: ReturnType<typeof measureTransitionWidths> = null;
    const measure = () => {
      const width = element.clientWidth;
      const transitions = panelWidthTransitions(element);
      if (
        transitions.length !== (transitionWidths?.transitions.length ?? 0) ||
        transitions.some((animation, index) => animation !== transitionWidths?.transitions[index])
      ) {
        const settling = measureTransitionWidths(element, transitions);
        if (settling && transitionWidths) {
          settling.narrowestWidth = Math.min(
            settling.narrowestWidth,
            transitionWidths.narrowestWidth,
          );
        }
        transitionWidths = settling;
        // The last resize can arrive while the transitions still count as running.
        if (settling) {
          void Promise.allSettled(settling.transitions.map((animation) => animation.finished)).then(
            () => {
              if (disposed || transitionWidths !== settling) return;
              measure();
            },
          );
        }
      }
      const canvasBounds = element.getBoundingClientRect();
      const findBarBounds = findBar?.getBoundingClientRect();
      const styles = getComputedStyle(probe);
      store.getState().setMeasurements({
        findBar:
          detailsCardTopInset > 0
            ? {
                left: findBarBounds ? findBarBounds.left - canvasBounds.left : 0,
                right: findBarBounds ? findBarBounds.right - canvasBounds.left : 0,
                bottom: findBarBounds ? findBarBounds.bottom - canvasBounds.top : 0,
              }
            : null,
        width,
        narrowestWidth: transitionWidths?.narrowestWidth ?? width,
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
    const stopObserving = observeResize(observed, measure);
    return () => {
      disposed = true;
      stopObserving();
    };
  }, [store, composerOverlayElement, timelineElement, detailsCardTopInset]);
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
  };
  const { layout } = context;
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
