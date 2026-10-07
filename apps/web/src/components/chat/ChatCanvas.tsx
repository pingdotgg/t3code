import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout, type ChatCanvasDetailsCard } from "./chatCanvasLayout";

/**
 * Owns the available conversation space. Cards only report where they sit; the
 * canvas decides when chat moves over to make room for them.
 */
export function ChatCanvas({
  children,
  ...props
}: Omit<ComponentProps<"div">, "className" | "style" | "ref">) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const widthProbeRef = useRef<HTMLDivElement | null>(null);
  const [timelineElement, registerTimeline] = useState<HTMLElement | null>(null);
  const [detailsCard, setDetailsCard] = useState<ChatCanvasDetailsCard | null>(null);
  const reportDetailsCard = useCallback((next: ChatCanvasDetailsCard | null) => {
    setDetailsCard((current) =>
      current?.left === next?.left &&
      current?.right === next?.right &&
      current?.bottom === next?.bottom
        ? current
        : next,
    );
  }, []);
  const [measurements, setMeasurements] = useState({
    width: 0,
    height: 0,
    padding: 20,
    maxChatWidth: 768,
    minChatWidth: 640,
    timelineGutter: 0,
  });
  useLayoutEffect(() => {
    const element = elementRef.current;
    const probe = widthProbeRef.current;
    if (!element || !probe) return;
    const measure = () => {
      const styles = getComputedStyle(probe);
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
        padding: Number.parseFloat(styles.paddingLeft),
        maxChatWidth: Number.parseFloat(styles.width),
        minChatWidth: Number.parseFloat(styles.minWidth),
        timelineGutter: timelineElement
          ? (timelineElement.offsetWidth - timelineElement.clientWidth) / 2
          : 0,
      };
      setMeasurements((current) =>
        Object.keys(next).every(
          (key) => current[key as keyof typeof current] === next[key as keyof typeof next],
        )
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(probe);
    if (timelineElement) observer.observe(timelineElement);
    return () => observer.disconnect();
  }, [timelineElement]);
  const context = useMemo(() => {
    const container = { width: measurements.width, height: measurements.height };
    return {
      container,
      lane: { padding: measurements.padding, minChatWidth: measurements.minChatWidth },
      layout: resolveChatCanvasLayout({ ...measurements, container, detailsCard }),
      registerTimeline,
      reportDetailsCard,
    };
  }, [measurements, detailsCard, reportDetailsCard]);
  const { layout } = context;
  return (
    <ChatCanvasContext value={context}>
      <div
        {...props}
        ref={elementRef}
        data-chat-canvas
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
          className="pointer-events-none invisible absolute h-0 w-(--chat-content-max-width) min-w-[40rem] box-content ps-3 sm:ps-5"
        />
        {children}
      </div>
    </ChatCanvasContext>
  );
}
