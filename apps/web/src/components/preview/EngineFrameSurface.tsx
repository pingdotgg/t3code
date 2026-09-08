import type { PreviewInputEvent, PreviewMouseButton, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

const RESIZE_SETTLE_MS = 150;
const RETRY_STREAM_MS = 1000;
const MOUSE_BUTTONS: Record<number, PreviewMouseButton> = { 0: "left", 1: "middle", 2: "right" };

interface Props {
  threadRef: ScopedThreadRef;
  tabId: string;
  /** Server-relative MJPEG stream path from the session snapshot. */
  frameUrl: string;
  httpBaseUrl: string;
  visible: boolean;
}

/** Shows a headless engine page as an MJPEG stream and sends pointer and key input back. */
export function EngineFrameSurface({ threadRef, tabId, frameUrl, httpBaseUrl, visible }: Props) {
  const sendInput = useAtomCommand(previewEnvironment.input);
  const resize = useAtomCommand(previewEnvironment.resize);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pendingRef = useRef<{
    move: PreviewInputEvent | undefined;
    wheel: PreviewInputEvent | undefined;
  }>({
    move: undefined,
    wheel: undefined,
  });
  const inFlightRef = useRef(false);
  const [streamAttempt, setStreamAttempt] = useState(0);

  const send = useCallback(
    (event: PreviewInputEvent) =>
      sendInput({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, tabId, event },
      }),
    [sendInput, tabId, threadRef.environmentId, threadRef.threadId],
  );

  // Moves and wheel deltas arrive faster than one page round trip. Only one is
  // in flight at a time and the newest waiting one replaces the older ones.
  const flushPending = useCallback(
    function flush() {
      const pending = pendingRef.current;
      const event = pending.move ?? pending.wheel;
      if (inFlightRef.current || event === undefined) return;
      if (event === pending.move) pending.move = undefined;
      else pending.wheel = undefined;
      inFlightRef.current = true;
      void send(event).finally(() => {
        inFlightRef.current = false;
        flush();
      });
    },
    [send],
  );

  // Frames are viewport-sized and drawn top-left with object-contain, so one
  // scale factor maps client pixels back to page pixels.
  const pagePoint = useCallback((clientX: number, clientY: number) => {
    const image = imageRef.current;
    if (!image || image.naturalWidth === 0) return null;
    const rect = image.getBoundingClientRect();
    const scale = Math.max(image.naturalWidth / rect.width, image.naturalHeight / rect.height);
    return {
      x: Math.round((clientX - rect.left) * scale),
      y: Math.round((clientY - rect.top) * scale),
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width < 1 || height < 1) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void resize({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            tabId,
            viewport: { _tag: "freeform", width: Math.round(width), height: Math.round(height) },
          },
        });
      }, RESIZE_SETTLE_MS);
    });
    observer.observe(container);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [resize, tabId, threadRef.environmentId, threadRef.threadId]);

  // React registers wheel listeners as passive, so preventDefault must go through the DOM.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      const point = pagePoint(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const waiting = pendingRef.current.wheel;
      pendingRef.current.wheel = {
        type: "wheel",
        ...point,
        deltaX: event.deltaX + (waiting?.type === "wheel" ? waiting.deltaX : 0),
        deltaY: event.deltaY + (waiting?.type === "wheel" ? waiting.deltaY : 0),
      };
      flushPending();
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [flushPending, pagePoint]);

  const handlePointer = (type: "mouseDown" | "mouseUp") => (event: React.PointerEvent) => {
    const button = MOUSE_BUTTONS[event.button];
    const point = pagePoint(event.clientX, event.clientY);
    if (!button || !point) return;
    if (type === "mouseDown") containerRef.current?.focus();
    void send({ type, ...point, button });
  };

  const handleKey = (type: "keyDown" | "keyUp") => (event: React.KeyboardEvent) => {
    // App shortcuts keep the modifier key. The page gets everything else.
    if (event.metaKey || event.key === "Escape") return;
    event.preventDefault();
    void send({ type, key: event.key });
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="relative h-full w-full cursor-default overflow-hidden bg-white outline-none select-none"
      onPointerMove={(event) => {
        const point = pagePoint(event.clientX, event.clientY);
        if (!point) return;
        pendingRef.current.move = { type: "mouseMove", ...point };
        flushPending();
      }}
      onPointerDown={handlePointer("mouseDown")}
      onPointerUp={handlePointer("mouseUp")}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKey("keyDown")}
      onKeyUp={handleKey("keyUp")}
    >
      {visible ? (
        <img
          key={streamAttempt}
          ref={imageRef}
          src={new URL(frameUrl, httpBaseUrl).toString()}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-contain object-left-top"
          onError={() => {
            setTimeout(() => setStreamAttempt((attempt) => attempt + 1), RETRY_STREAM_MS);
          }}
        />
      ) : null}
    </div>
  );
}
