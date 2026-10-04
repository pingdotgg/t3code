"use client";

import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  previewStreamModifiers,
  type PreviewStreamClient,
  type PreviewStreamInput,
  type PreviewStreamMouseButton,
  type PreviewStreamViewport,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { refreshPreviewStreamAccess, usePreviewStreamAccess } from "~/state/previewStream";

/** Chrome-row controls for a server tab. A command issued before the socket opens waits for it. */
export interface ServerBrowserHandle {
  readonly navigate: (url: string) => void;
  readonly history: (delta: -1 | 1) => void;
  readonly reload: () => void;
  /** The canvas showing the latest frame. */
  readonly canvas: () => HTMLCanvasElement | null;
}

const RESIZE_DEBOUNCE_MS = 150;
const ACCESS_RETRY_MS = 10_000;
// A recent probe answer near a new tap stands in for that tap's own answer,
// which on a slow link arrives after the tap ends.
const PROBE_REUSE_PX = 24;
const PROBE_REUSE_MS = 10_000;
// Kept in the input so soft keyboards have something to delete: Android
// reports Backspace only as a deletion of text, not as a key.
const INPUT_SENTINEL = "\u200b";
const BACKSPACE = { key: "Backspace", code: "Backspace", keyCode: 8 } as const;
const DELETE = { key: "Delete", code: "Delete", keyCode: 46 } as const;
const MAX_UNAUTHORIZED_REFUSALS = 3;
const TAP_SLOP_PX = 8;
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP_PX = 4;
const WHEEL_LINE_PX = 16;

type MouseInput = Extract<PreviewStreamInput, { type: "mouse" }>;
type WheelInput = Extract<PreviewStreamInput, { type: "wheel" }>;

interface PagePoint {
  readonly x: number;
  readonly y: number;
  /** Page CSS px per client px. */
  readonly scale: number;
}

interface TouchGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  panning: boolean;
}

/** Whether the page point under a touch takes text; null until the server answers. */
interface TouchProbe {
  readonly x: number;
  readonly y: number;
  editable: boolean | null;
  /** True only for this tap's own reply, never for a cached answer. */
  answered: boolean;
  /** The tap ended before the answer arrived. */
  tapped: boolean;
}

const buttonOf = (button: number): PreviewStreamMouseButton =>
  button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";

const pressedButtonOf = (buttons: number): PreviewStreamMouseButton =>
  buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none";

/**
 * A server-hosted preview tab: JPEG frames from the environment's headless
 * Chromium drawn into a canvas, with pointer, wheel, and keyboard input sent
 * back in page coordinates. Touch taps click and touch drags scroll; the soft
 * keyboard opens only for taps the server reports as landing on a text field.
 * `visible=false` closes the stream so a hidden panel decodes nothing.
 */
export function ServerBrowserSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly tabId: string;
  readonly visible: boolean;
  /** Sends the surface size so fill-mode tabs follow it. The floating player scales the page instead. */
  readonly followSize?: boolean;
  readonly onFirstFrame?: () => void;
  readonly onViewport?: (viewport: PreviewStreamViewport) => void;
  readonly className?: string;
  readonly ref?: Ref<ServerBrowserHandle>;
}) {
  const {
    environmentId,
    threadId,
    tabId,
    visible,
    followSize = true,
    onFirstFrame,
    onViewport,
    className,
    ref,
  } = props;
  const access = usePreviewStreamAccess(environmentId);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const keySentRef = useRef(false);
  const clientRef = useRef<PreviewStreamClient | null>(null);
  const viewportRef = useRef<PreviewStreamViewport | null>(null);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const hasFrameRef = useRef(false);
  const pendingCommandRef = useRef<PreviewStreamInput | null>(null);
  const unauthorizedRef = useRef(0);
  const [accessDenied, setAccessDenied] = useState(false);
  const pendingMoveRef = useRef<MouseInput | null>(null);
  const pendingWheelRef = useRef<WheelInput | null>(null);
  const inputFrameRef = useRef<number | null>(null);
  const mouseButtonsRef = useRef(0);
  const mouseClicksRef = useRef({ left: 1, middle: 1, right: 1, none: 1 });
  const lastClickRef = useRef<{
    button: PreviewStreamMouseButton;
    time: number;
    x: number;
    y: number;
    count: number;
  } | null>(null);
  const touchRef = useRef<TouchGesture | null>(null);
  const probeRef = useRef<TouchProbe | null>(null);
  const lastProbeRef = useRef<{ x: number; y: number; editable: boolean; at: number } | null>(null);
  const firstFrame = useEffectEvent(() => onFirstFrame?.());
  const viewportChanged = useEffectEvent((viewport: PreviewStreamViewport) =>
    onViewport?.(viewport),
  );
  // Frame cap in device px, fixed per socket. It grows with the surface and
  // never shrinks, so only outgrowing it reconnects.
  const [cap, setCap] = useState<{ width: number; height: number } | null>(null);

  const send = useCallback((input: PreviewStreamInput) => {
    clientRef.current?.send(input);
  }, []);

  const flushInput = useCallback(() => {
    if (inputFrameRef.current !== null) cancelAnimationFrame(inputFrameRef.current);
    inputFrameRef.current = null;
    const move = pendingMoveRef.current;
    const wheel = pendingWheelRef.current;
    pendingMoveRef.current = null;
    pendingWheelRef.current = null;
    if (move) send(move);
    if (wheel) send(wheel);
  }, [send]);

  // Moves and wheel deltas coalesce to one message each per animation frame.
  // `flushInput` only closes over refs and `send`, so it never changes.
  const scheduleFlush = useCallback(() => {
    inputFrameRef.current ??= requestAnimationFrame(flushInput);
  }, []);

  const queueWheel = useCallback(
    (point: PagePoint, deltaX: number, deltaY: number, modifiers: number) => {
      const pending = pendingWheelRef.current;
      pendingWheelRef.current = {
        type: "wheel",
        x: point.x,
        y: point.y,
        deltaX: (pending?.deltaX ?? 0) + deltaX,
        deltaY: (pending?.deltaY ?? 0) + deltaY,
        modifiers,
      };
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const pagePoint = useCallback(
    (clientX: number, clientY: number, clamp: boolean): PagePoint | null => {
      const canvas = canvasRef.current;
      const viewport = viewportRef.current;
      if (!canvas || !viewport || !hasFrameRef.current) return null;
      const rect = canvas.getBoundingClientRect();
      // `object-contain` letterboxes the frame inside the canvas box.
      const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
      const width = canvas.width * fit;
      const height = canvas.height * fit;
      if (!(width > 0 && height > 0)) return null;
      const scale = viewport.width / width;
      const x = (clientX - rect.left - (rect.width - width) / 2) * scale;
      const y = (clientY - rect.top - (rect.height - height) / 2) * (viewport.height / height);
      const inside = x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
      if (!inside && !clamp) return null;
      return {
        x: Math.min(Math.max(x, 0), viewport.width),
        y: Math.min(Math.max(y, 0), viewport.height),
        scale,
      };
    },
    [],
  );

  const countClick = (button: PreviewStreamMouseButton, x: number, y: number, time: number) => {
    const last = lastClickRef.current;
    const count =
      last &&
      last.button === button &&
      time - last.time < MULTI_CLICK_MS &&
      Math.hypot(x - last.x, y - last.y) < MULTI_CLICK_SLOP_PX
        ? last.count + 1
        : 1;
    lastClickRef.current = { button, time, x, y, count };
    return count;
  };

  const focusInput = () => inputRef.current?.focus({ preventScroll: true });

  useImperativeHandle(ref, () => {
    const command = (input: PreviewStreamInput) => {
      if (clientRef.current?.send(input)) return;
      pendingCommandRef.current = input;
    };
    return {
      navigate: (url) => command({ type: "navigate", url }),
      history: (delta) => command({ type: "history", delta }),
      reload: () => command({ type: "reload" }),
      canvas: () => (hasFrameRef.current ? canvasRef.current : null),
    };
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      timer = null;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      const previous = sizeRef.current;
      if (previous?.width === size.width && previous.height === size.height) return;
      sizeRef.current = size;
      if (followSize) clientRef.current?.send({ type: "resize", ...size });
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(size.width * ratio);
      const height = Math.round(size.height * ratio);
      setCap((current) =>
        current !== null && current.width >= width && current.height >= height
          ? current
          : {
              width: Math.max(width, current?.width ?? 0),
              height: Math.max(height, current?.height ?? 0),
            },
      );
    };
    const observer = new ResizeObserver(() => {
      if (timer !== null) clearTimeout(timer);
      // The first size connects right away; later ones settle before resizing the page.
      timer = setTimeout(measure, sizeRef.current === null ? 0 : RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [followSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || accessDenied || !access || !cap || !canvas) return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const painter = createPreviewFramePainter(canvas, () => {
      if (hasFrameRef.current) return;
      hasFrameRef.current = true;
      firstFrame();
    });
    const client = createPreviewStreamClient(
      { access, threadId, tabId, maxWidth: cap.width, maxHeight: cap.height },
      {
        onFrame: (jpeg) => {
          unauthorizedRef.current = 0;
          painter.paint(jpeg);
        },
        onProbe: (result) => {
          lastProbeRef.current = { ...result, at: performance.now() };
          const probe = probeRef.current;
          if (!probe || probe.x !== result.x || probe.y !== result.y) return;
          probe.editable = result.editable;
          probe.answered = true;
          if (!probe.tapped) return;
          // Late answer: Android still raises the keyboard; iOS waits for the next tap.
          probeRef.current = null;
          if (result.editable) inputRef.current?.focus({ preventScroll: true });
          else inputRef.current?.blur();
        },
        onViewport: (viewport) => {
          viewportRef.current = viewport;
          viewportChanged(viewport);
        },
        onConnectedChange: (connected) => {
          if (!connected) return;
          const size = sizeRef.current;
          if (followSize && size) client.send({ type: "resize", ...size });
          const command = pendingCommandRef.current;
          pendingCommandRef.current = null;
          if (command) client.send(command);
        },
        onUnauthorized: () => {
          // Fresh tickets re-run this effect. Repeated refusals need an explicit retry.
          const refusals = ++unauthorizedRef.current;
          if (refusals >= MAX_UNAUTHORIZED_REFUSALS) {
            inputRef.current?.blur();
            setAccessDenied(true);
            return;
          }
          refreshTimer = setTimeout(
            () => refreshPreviewStreamAccess(environmentId),
            refusals === 1 ? 0 : 1_000 * 2 ** (refusals - 1),
          );
        },
      },
    );
    clientRef.current = client;
    return () => {
      painter.stop();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [access, accessDenied, cap, environmentId, followSize, tabId, threadId, visible]);

  useEffect(() => {
    if (!visible || accessDenied || access !== null) return;
    // A failed ticket mint, e.g. while the server restarts, never retries on its own.
    const timer = setInterval(() => refreshPreviewStreamAccess(environmentId), ACCESS_RETRY_MS);
    return () => clearInterval(timer);
  }, [access, accessDenied, environmentId, visible]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Registered natively: React's wheel listener is passive and cannot stop the panel scrolling.
    const onWheel = (event: WheelEvent) => {
      const point = pagePoint(event.clientX, event.clientY, false);
      if (!point) return;
      event.preventDefault();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? WHEEL_LINE_PX
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? (viewportRef.current?.height ?? 0)
            : 1;
      queueWheel(point, event.deltaX * unit, event.deltaY * unit, previewStreamModifiers(event));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [pagePoint, queueWheel]);

  useEffect(
    () => () => {
      if (inputFrameRef.current !== null) cancelAnimationFrame(inputFrameRef.current);
    },
    [],
  );

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch") {
      if (!event.isPrimary) return;
      touchRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        panning: false,
      };
      const point = pagePoint(event.clientX, event.clientY, false);
      const last = lastProbeRef.current;
      const reusable =
        point !== null &&
        last !== null &&
        performance.now() - last.at < PROBE_REUSE_MS &&
        Math.hypot(point.x - last.x, point.y - last.y) < PROBE_REUSE_PX;
      probeRef.current = point
        ? {
            x: point.x,
            y: point.y,
            editable: reusable ? last.editable : null,
            answered: false,
            tapped: false,
          }
        : null;
      if (point) send({ type: "probe", x: point.x, y: point.y });
      return;
    }
    focusInput();
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    flushInput();
    mouseButtonsRef.current = event.buttons & 7;
    const button = buttonOf(event.button);
    const clickCount = countClick(button, event.clientX, event.clientY, event.timeStamp);
    mouseClicksRef.current[button] = clickCount;
    send({
      type: "mouse",
      action: "down",
      x: point.x,
      y: point.y,
      button,
      buttons: event.buttons,
      clickCount,
      modifiers: previewStreamModifiers(event),
    });
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch") {
      const touch = touchRef.current;
      if (!touch || touch.pointerId !== event.pointerId) return;
      if (
        !touch.panning &&
        Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) < TAP_SLOP_PX
      ) {
        return;
      }
      touch.panning = true;
      const point = pagePoint(event.clientX, event.clientY, true);
      // Dragging the page up scrolls it down, following the finger.
      if (point) {
        queueWheel(
          point,
          (touch.lastX - event.clientX) * point.scale,
          (touch.lastY - event.clientY) * point.scale,
          0,
        );
      }
      touch.lastX = event.clientX;
      touch.lastY = event.clientY;
      return;
    }
    const point = pagePoint(
      event.clientX,
      event.clientY,
      mouseButtonsRef.current !== 0 || event.buttons !== 0,
    );
    if (!point) return;
    // Chorded presses and releases arrive as pointermove while another button is held.
    const changed = mouseButtonsRef.current ^ (event.buttons & 7);
    if (mouseButtonsRef.current !== 0 && changed !== 0) {
      flushInput();
      for (const bit of [1, 2, 4]) {
        if (!(changed & bit)) continue;
        const button = pressedButtonOf(bit);
        const down = (event.buttons & bit) !== 0;
        mouseButtonsRef.current ^= bit;
        if (down) {
          mouseClicksRef.current[button] = countClick(
            button,
            event.clientX,
            event.clientY,
            event.timeStamp,
          );
        }
        send({
          type: "mouse",
          action: down ? "down" : "up",
          x: point.x,
          y: point.y,
          button,
          buttons: mouseButtonsRef.current,
          clickCount: mouseClicksRef.current[button],
          modifiers: previewStreamModifiers(event),
        });
      }
    }
    pendingMoveRef.current = {
      type: "mouse",
      action: "move",
      x: point.x,
      y: point.y,
      button: pressedButtonOf(event.buttons),
      buttons: event.buttons,
      clickCount: 0,
      modifiers: previewStreamModifiers(event),
    };
    scheduleFlush();
  };

  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch") {
      const touch = touchRef.current;
      if (!touch || touch.pointerId !== event.pointerId) return;
      touchRef.current = null;
      const probe = probeRef.current;
      if (touch.panning) {
        probeRef.current = null;
        return;
      }
      const point = pagePoint(event.clientX, event.clientY, false);
      if (!point) return;
      // Focusing inside the tap's user activation is what lets iOS raise the keyboard.
      if (probe?.editable === true) focusInput();
      else if (probe?.editable === false) inputRef.current?.blur();
      if (probe && !probe.answered) probe.tapped = true;
      else probeRef.current = null;
      flushInput();
      const clickCount = countClick("left", event.clientX, event.clientY, event.timeStamp);
      const at = { x: point.x, y: point.y, modifiers: 0 };
      send({ type: "mouse", action: "move", ...at, button: "none", buttons: 0, clickCount: 0 });
      send({ type: "mouse", action: "down", ...at, button: "left", buttons: 1, clickCount });
      send({ type: "mouse", action: "up", ...at, button: "left", buttons: 0, clickCount });
      return;
    }
    if (mouseButtonsRef.current === 0) return;
    mouseButtonsRef.current = event.buttons & 7;
    const point = pagePoint(event.clientX, event.clientY, true);
    if (!point) return;
    flushInput();
    send({
      type: "mouse",
      action: "up",
      x: point.x,
      y: point.y,
      button: buttonOf(event.button),
      buttons: event.buttons,
      clickCount: mouseClicksRef.current[buttonOf(event.button)],
      modifiers: previewStreamModifiers(event),
    });
  };

  const handlePointerCancel = (event: PointerEvent<HTMLCanvasElement>) => {
    if (touchRef.current?.pointerId === event.pointerId) {
      touchRef.current = null;
      probeRef.current = null;
      return;
    }
    let buttons = mouseButtonsRef.current;
    if (buttons === 0) return;
    // A cancelled drag must release every button held in the page.
    mouseButtonsRef.current = 0;
    const point = pagePoint(event.clientX, event.clientY, true);
    if (!point) return;
    flushInput();
    for (const bit of [1, 2, 4]) {
      if (!(buttons & bit)) continue;
      buttons &= ~bit;
      const button = pressedButtonOf(bit);
      send({
        type: "mouse",
        action: "up",
        x: point.x,
        y: point.y,
        button,
        buttons,
        clickCount: mouseClicksRef.current[button],
        modifiers: previewStreamModifiers(event),
      });
    }
  };

  const resetInput = (textarea: HTMLTextAreaElement) => {
    keySentRef.current = false;
    textarea.value = INPUT_SENTINEL;
    textarea.setSelectionRange(INPUT_SENTINEL.length, INPUT_SENTINEL.length);
  };

  const sendKeyPress = (key: typeof BACKSPACE | typeof DELETE) => {
    send({ type: "key", action: "down", ...key, modifiers: 0 });
    send({ type: "key", action: "up", ...key, modifiers: 0 });
  };

  const handleKey = (action: "down" | "up", event: KeyboardEvent<HTMLTextAreaElement>) => {
    keySentRef.current = false;
    // IME and soft keyboards deliver text through composition and input events.
    if (
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.key === "Process" ||
      event.key === "Unidentified"
    ) {
      return;
    }
    // Keep plain Escape and Tab in the page; Shift+Escape returns to the app.
    if (event.key === "Escape" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (action === "down") event.currentTarget.blur();
      return;
    }
    const shortcut = event.ctrlKey || event.metaKey;
    // Paste arrives as a paste event carrying this device's clipboard. Cut is not forwarded:
    // the page's selection never reaches this clipboard, so it would be lost.
    if (shortcut && ["v", "x"].includes(event.key.toLowerCase())) return;
    // Enter carries "\r" like Puppeteer's key table, so forms submit and textareas break lines.
    const text = shortcut
      ? undefined
      : [...event.key].length === 1
        ? event.key
        : event.key === "Enter"
          ? "\r"
          : undefined;
    send({
      type: "key",
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      ...(action === "down" && text !== undefined ? { text } : {}),
      modifiers: previewStreamModifiers(event),
    });
    // Some Android keyboards edit the textarea even when keydown is prevented.
    keySentRef.current =
      action === "down" &&
      !shortcut &&
      (text !== undefined || event.key === "Backspace" || event.key === "Delete");
    // Shortcuts stay with the app (copy, paste, keybindings); other keys belong to the page.
    if (shortcut) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent;
    if (native instanceof InputEvent && native.isComposing) return;
    const textarea = event.currentTarget;
    const inputType = native instanceof InputEvent ? native.inputType : "";
    if (keySentRef.current) keySentRef.current = false;
    else if (inputType === "deleteContentBackward") sendKeyPress(BACKSPACE);
    else if (inputType === "deleteContentForward") sendKeyPress(DELETE);
    else {
      const text = textarea.value.replaceAll(INPUT_SENTINEL, "");
      if (text) send({ type: "text", text });
    }
    resetInput(textarea);
  };

  const handleCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    if (event.data) send({ type: "text", text: event.data });
    resetInput(event.currentTarget);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (text) send({ type: "text", text });
  };

  return (
    <div
      ref={containerRef}
      className={cn("relative overflow-hidden", className)}
      data-server-browser-surface={tabId}
    >
      <canvas
        ref={canvasRef}
        className="block size-full touch-none object-contain"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        // Keeps focus in the page input below and stops native text selection.
        onMouseDown={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
      />
      {/* Focus target for page keyboard input. Pinned top-left so focusing it never
          scrolls the surface; 16px keeps iOS from zooming the app on focus. */}
      <textarea
        ref={inputRef}
        aria-label="Browser page"
        aria-description="Press Shift+Escape to leave the browser page."
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        defaultValue={INPUT_SENTINEL}
        // The caret must sit after the sentinel for a deletion to have something to delete.
        onFocus={(event) => resetInput(event.currentTarget)}
        className="sr-only top-0 left-0 text-base"
        onKeyDown={(event) => handleKey("down", event)}
        onKeyUp={(event) => handleKey("up", event)}
        onInput={handleInput}
        onCompositionEnd={handleCompositionEnd}
        // Copying the input would put its sentinel on this device's clipboard.
        onCopy={(event) => event.preventDefault()}
        onCut={(event) => event.preventDefault()}
        onPaste={handlePaste}
      />
      {visible && accessDenied ? (
        // The page can be invisible beneath an empty or unreachable state; reconnect must remain reachable.
        <div className="visible absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background p-3 text-center">
          <p role="alert" className="text-xs text-muted-foreground">
            Browser connection was refused.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              unauthorizedRef.current = 0;
              setAccessDenied(false);
              refreshPreviewStreamAccess(environmentId);
            }}
          >
            Reconnect
          </Button>
        </div>
      ) : null}
    </div>
  );
}
