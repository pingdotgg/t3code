import type { PreviewInputEvent, PreviewMouseButton, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";

import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

const RESIZE_SETTLE_MS = 150;
const RETRY_STREAM_MS = 1000;
const MOUSE_BUTTONS: Record<number, PreviewMouseButton> = { 0: "left", 1: "middle", 2: "right" };

interface Props {
  threadRef: ScopedThreadRef;
  tabId: string;
  /** Server-relative frame stream path from the session snapshot. */
  frameUrl: string;
  httpBaseUrl: string;
  visible: boolean;
}

/** Yields each length-prefixed image in the stream as soon as its last byte arrives. */
async function* readFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let buffered = 0;
  let expected = -1;
  const take = (count: number) => {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const chunk = chunks[0];
      if (chunk === undefined) break;
      const part = chunk.subarray(0, count - filled);
      out.set(part, filled);
      filled += part.byteLength;
      if (part.byteLength === chunk.byteLength) chunks.shift();
      else chunks[0] = chunk.subarray(part.byteLength);
    }
    buffered -= count;
    return out;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    chunks.push(value);
    buffered += value.byteLength;
    while (true) {
      if (expected < 0) {
        if (buffered < 4) break;
        expected = new DataView(take(4).buffer).getUint32(0);
      }
      if (buffered < expected) break;
      yield take(expected);
      expected = -1;
    }
  }
}

/** Shows a headless engine page on a canvas and sends pointer and key input back. */
export function EngineFrameSurface({ threadRef, tabId, frameUrl, httpBaseUrl, visible }: Props) {
  const sendInput = useAtomCommand(previewEnvironment.input);
  const resize = useAtomCommand(previewEnvironment.resize);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingRef = useRef<{
    move: PreviewInputEvent | undefined;
    wheel: PreviewInputEvent | undefined;
  }>({ move: undefined, wheel: undefined });
  const inFlightRef = useRef(false);

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

  // The page viewport follows the container size, so client pixels map to page
  // pixels one to one.
  const pagePoint = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return { x: Math.round(clientX - rect.left), y: Math.round(clientY - rect.top) };
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

  // Frames decode off the main thread, one at a time, and the newest one is
  // drawn once per animation frame. A burst after a stall costs one decode.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    const controller = new AbortController();
    let newest: ImageBitmap | null = null;
    let waiting: Uint8Array<ArrayBuffer> | null = null;
    let decoding = false;
    let animationFrame = 0;

    const draw = () => {
      animationFrame = 0;
      const bitmap = newest;
      if (!bitmap) return;
      newest = null;
      const scale = window.devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      const width = Math.round(rect.width * scale);
      const height = Math.round(rect.height * scale);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext("2d");
      if (context) {
        const fit = Math.min(width / bitmap.width, height / bitmap.height);
        const drawWidth = Math.round(bitmap.width * fit);
        const drawHeight = Math.round(bitmap.height * fit);
        context.imageSmoothingQuality = "high";
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, drawWidth, drawHeight);
      }
      bitmap.close();
    };

    const onFrame = (bitmap: ImageBitmap) => {
      if (controller.signal.aborted) {
        bitmap.close();
        return;
      }
      newest?.close();
      newest = bitmap;
      if (!animationFrame) animationFrame = requestAnimationFrame(draw);
    };

    const decode = (bytes: Uint8Array<ArrayBuffer>) => {
      decoding = true;
      void createImageBitmap(new Blob([bytes]))
        .then(onFrame, () => undefined)
        .finally(() => {
          decoding = false;
          if (waiting === null) return;
          const next = waiting;
          waiting = null;
          decode(next);
        });
    };

    const stream = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(new URL(frameUrl, httpBaseUrl), {
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(response.statusText);
          for await (const bytes of readFrames(response.body)) {
            if (decoding) waiting = bytes;
            else decode(bytes);
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_STREAM_MS));
      }
    };
    void stream();

    return () => {
      controller.abort();
      cancelAnimationFrame(animationFrame);
      newest?.close();
    };
  }, [frameUrl, httpBaseUrl, visible]);

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
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
