import {
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { observeResize } from "../../lib/observeResize";
import { ChatWorkspaceGeometryContext } from "../ChatWorkspace";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout, type ChatCanvasPreview } from "./chatCanvasLayout";
import {
  resolveThreadDetailsCardLayout,
  THREAD_DETAILS_CARD_GAP,
  THREAD_DETAILS_CARD_WIDTH,
} from "./threadDetailsCardLayout";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";

const CARD_SPACE = THREAD_DETAILS_CARD_WIDTH + THREAD_DETAILS_CARD_GAP + DETAILS_CARD_CLEARANCE;

function cardReservation(width: number, lane: { padding: number; maxChatWidth: number }) {
  return Math.max(
    0,
    Math.min(lane.maxChatWidth + CARD_SPACE * 2 - width, CARD_SPACE - lane.padding),
  );
}

function useCardBox(placement: ReturnType<typeof resolveThreadDetailsCardLayout>, settled = false) {
  const x = settled ? placement?.x : undefined;
  const y = placement?.y,
    width = placement?.width,
    height = placement?.height;
  return useMemo(
    () =>
      y === undefined || width === undefined || height === undefined
        ? null
        : { x, y, width, height },
    [x, y, width, height],
  );
}

export function ChatCanvas({
  composerOverlayElement,
  detailsCardTopInset = 0,
  children,
  ...props
}: Omit<ComponentProps<"div">, "className" | "style" | "ref"> & {
  composerOverlayElement: HTMLElement | null;
  detailsCardTopInset?: number;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const widthProbeRef = useRef<HTMLDivElement | null>(null);
  const reservationProbeRef = useRef<HTMLDivElement | null>(null);
  const [timelineElement, registerTimeline] = useState<HTMLElement | null>(null);
  const [preview, setPreview] = useState<ChatCanvasPreview | null>(null);
  const [card, setCard] = useState({ inlineOpen: false, contentHeight: 0 });
  const [measurements, setMeasurements] = useState({
    width: 0,
    height: 0,
    padding: 48,
    maxChatWidth: 736,
    minChatWidth: 640,
    composerHeight: 0,
    timelineGutter: 0,
    findBarLeft: 0,
    findBarRight: 0,
    findBarBottom: 0,
  });
  const measurementsRef = useRef(measurements);
  const containerRef = useRef({ width: 0, height: 0 });
  const readContainer = useCallback(() => containerRef.current, []);
  const geometry = use(ChatWorkspaceGeometryContext);
  const estimatedWidth = geometry?.width ?? measurements.width;
  const moving = geometry?.moving ?? false;
  const previewActive = preview !== null;
  const targetWidth = moving ? Math.round(estimatedWidth) : measurements.width;
  const dockingWidth = moving && geometry ? geometry.dockingWidth : measurements.width;
  const findBar =
    detailsCardTopInset > 0
      ? {
          left: measurements.findBarLeft,
          right: measurements.findBarRight,
          bottom: measurements.findBarBottom,
        }
      : null;
  const cardLayout = {
    container: { width: targetWidth, height: measurements.height },
    lane: { padding: measurements.padding, minChatWidth: measurements.minChatWidth },
    frame: null,
    topInset: findBar?.bottom ?? 0,
  };
  const targetCard = resolveThreadDetailsCardLayout(cardLayout);
  const container = {
    width: preview ? measurements.width : targetWidth,
    height: measurements.height,
  };
  const preferred = resolveThreadDetailsCardLayout({
    ...cardLayout,
    container,
    dockingWidth,
  });
  const reservation =
    card.inlineOpen && targetCard ? cardReservation(targetWidth, measurements) : 0;
  const liveReservation =
    !preview && moving && preferred !== null && targetCard !== null && card.inlineOpen;
  const detailsCard =
    card.inlineOpen && preferred && card.contentHeight > 0
      ? {
          left: preferred.x,
          right: preferred.x + preferred.width,
          bottom: preferred.y + Math.min(card.contentHeight, preferred.height),
        }
      : null;
  const layout = resolveChatCanvasLayout({
    ...measurements,
    container,
    preview,
    detailsCard,
    findBar,
  });
  const placement = resolveThreadDetailsCardLayout({
    ...cardLayout,
    container,
    frame: layout.frame,
    overlapsDetailsCard: layout.overlapsDetailsCard,
    dockingWidth,
  });
  const insetEnd = preview || !moving ? layout.chat.insetEnd : reservation;
  const reservationValue = liveReservation
    ? `clamp(0px, calc(${measurements.maxChatWidth === Infinity ? "100%" : `${measurements.maxChatWidth}px`} + ${CARD_SPACE * 2}px - 100% - ${Math.round(estimatedWidth) - estimatedWidth}px), ${CARD_SPACE - measurements.padding}px)`
    : `${insetEnd}px`;
  useLayoutEffect(() => {
    const probe = reservationProbeRef.current;
    const targets = elementRef.current?.querySelectorAll<HTMLElement>(
      ".chat-composer-lane, .messages-timeline-scroll, .chat-scroll-to-bottom",
    );
    if (!probe || !targets) return;
    const apply = (width: number) => {
      const value = moving && !previewActive ? `${width}px` : reservationValue;
      targets.forEach((target) => target.style.setProperty("--chat-card-reservation", value));
    };
    apply(probe.getBoundingClientRect().width);
    return observeResize(probe, ([entry]) => {
      if (entry) apply(entry.contentRect.width);
    });
  }, [reservationValue, moving, previewActive, timelineElement, composerOverlayElement, children]);
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
      const width = element.clientWidth;
      const height = element.clientHeight;
      containerRef.current = { width, height };
      geometry?.onMeasured(width);
      const next = {
        findBarLeft:
          moving && !previewActive
            ? measurementsRef.current.findBarLeft
            : findBarBounds
              ? findBarBounds.left - canvasBounds.left
              : 0,
        findBarRight:
          moving && !previewActive
            ? measurementsRef.current.findBarRight
            : findBarBounds
              ? findBarBounds.right - canvasBounds.left
              : 0,
        findBarBottom: findBarBounds ? findBarBounds.bottom - canvasBounds.top : 0,
        width: previewActive || !moving ? width : measurementsRef.current.width,
        height,
        padding: Number.parseFloat(styles.paddingLeft),
        maxChatWidth:
          styles.getPropertyValue("--chat-content-max-width").trim() === "100%"
            ? Infinity
            : Number.parseFloat(styles.width),
        minChatWidth: Number.parseFloat(styles.minWidth),
        composerHeight: composerOverlayElement?.getBoundingClientRect().height ?? 0,
        timelineGutter: timelineElement
          ? (timelineElement.offsetWidth - timelineElement.clientWidth) / 2
          : 0,
      };
      if (
        Object.keys(next).every(
          (key) =>
            measurementsRef.current[key as keyof typeof next] === next[key as keyof typeof next],
        )
      )
        return;
      measurementsRef.current = next;
      setMeasurements(next);
    };
    measure();
    const observed: Element[] = [element, probe];
    if (findBar) observed.push(findBar);
    if (composerOverlayElement) observed.push(composerOverlayElement);
    if (timelineElement) observed.push(timelineElement);
    return observeResize(observed, measure);
  }, [
    composerOverlayElement,
    timelineElement,
    geometry,
    moving,
    previewActive,
    detailsCardTopInset,
  ]);
  const reportPreview = useCallback((next: ChatCanvasPreview) => {
    setPreview((current) =>
      current?.key === next.key &&
      current.width === next.width &&
      current.lastInteraction === next.lastInteraction &&
      current.position?.x === next.position?.x &&
      current.position?.y === next.position?.y &&
      current.source.width === next.source.width &&
      current.source.height === next.source.height
        ? current
        : next,
    );
  }, []);
  const clearPreview = useCallback(
    (key: string) => setPreview((current) => (current?.key === key ? null : current)),
    [],
  );
  const reportDetailsCard = useCallback((inlineOpen: boolean, contentHeight: number) => {
    setCard((current) =>
      current.inlineOpen === inlineOpen && current.contentHeight === contentHeight
        ? current
        : { inlineOpen, contentHeight },
    );
  }, []);
  const preferredBox = useCardBox(preferred);
  const placementBox = useCardBox(placement, !moving);
  const context = useMemo(
    () => ({
      readContainer,
      detailsCardTopInset: findBar?.bottom ?? 0,
      previewKey: preview?.key ?? null,
      previewFrame: layout.frame,
      detailsCard: {
        preferred: preferredBox,
        placement: placementBox,
        containerHeight: measurements.height,
      },
      reportPreview,
      clearPreview,
      registerTimeline,
      reportDetailsCard,
    }),
    [
      readContainer,
      findBar?.bottom,
      preview?.key,
      layout.frame,
      preferredBox,
      placementBox,
      measurements.height,
      reportPreview,
      clearPreview,
      reportDetailsCard,
    ],
  );
  return (
    <ChatCanvasContext value={context}>
      <div
        {...props}
        ref={elementRef}
        data-chat-canvas
        data-preview-overlaps-chat={layout.overlapsChat || undefined}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <div
          data-chat-lane
          data-animated={moving && !preview && card.inlineOpen ? "true" : "false"}
          data-live-reservation={liveReservation ? "true" : "false"}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          style={
            {
              "--chat-timeline-gutter": `${measurements.timelineGutter}px`,
              "--chat-lane-inset-start": `${layout.chat.insetStart}px`,
              "--chat-canvas-rounding": `${Math.round(estimatedWidth) - estimatedWidth}px`,
            } as CSSProperties
          }
        >
          <div
            ref={reservationProbeRef}
            data-chat-reservation-source
            aria-hidden
            className="pointer-events-none invisible absolute h-0"
            style={{ width: reservationValue }}
          />
          <div
            ref={widthProbeRef}
            aria-hidden
            className="pointer-events-none invisible absolute h-0 w-(--chat-content-max-width) min-w-[40rem] box-content ps-3 sm:ps-12"
          />
          {children}
        </div>
      </div>
    </ChatCanvasContext>
  );
}
