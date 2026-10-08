"use client";

import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  previewStreamControlLabel,
  previewStreamModifiers,
  type PreviewStreamClient,
  type PreviewStreamControl,
  type PreviewStreamDownload,
  type PreviewStreamFileChooser,
  uploadPreviewStreamFiles,
  type PreviewStreamInput,
  type PreviewStreamMouseButton,
  type PreviewStreamPointer,
  type PreviewStreamViewport,
  previewStreamHostSetupMessage,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import type {
  EnvironmentId,
  PreviewStreamHostSetup,
  PreviewViewportSetting,
} from "@t3tools/contracts";
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { AgentCursorMark } from "~/components/preview/AgentBrowserCursor";
import { CommandBlock } from "~/components/CommandBlock";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { refreshPreviewStreamAccess, usePreviewStreamAccess } from "~/state/previewStream";

/** Chrome-row controls for a server tab; commands require current ownership. */
export interface ServerBrowserHandle {
  readonly navigate: (url: string) => void;
  readonly history: (delta: -1 | 1) => void;
  readonly reload: (options?: { readonly ignoreCache?: boolean }) => void;
  readonly viewport: (setting: PreviewViewportSetting) => void;
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

/** Browsers may refuse a write that arrives after the key press; a toast button is a fresh gesture. */
async function copyPageText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const id = toastManager.add({
      type: "info",
      title: "The page copied text",
      actionProps: {
        children: "Copy",
        onClick: () => {
          toastManager.close(id);
          void navigator.clipboard.writeText(text).catch(() => undefined);
        },
      },
    });
  }
}

/** The download happens on the environment; this hands the finished file to this device. */
function offerDownload(download: PreviewStreamDownload) {
  const id = toastManager.add({
    type: "info",
    title: `Downloaded ${download.fileName}`,
    actionProps: {
      children: "Save",
      onClick: () => {
        toastManager.close(id);
        const anchor = document.createElement("a");
        anchor.href = download.url;
        anchor.download = download.fileName;
        anchor.click();
      },
    },
  });
}

export function ServerBrowserSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly tabId: string;
  readonly visible: boolean;
  /** Sends the surface size so fill-mode tabs follow it. The floating player scales the page instead. */
  readonly followSize?: boolean;
  /** Floating previews reserve the top edge for their existing hover controls. */
  readonly controlPosition?: "top" | "bottom";
  readonly onFirstFrame?: () => void;
  readonly onViewport?: (viewport: PreviewStreamViewport) => void;
  readonly onControl?: (control: PreviewStreamControl | null) => void;
  /** Replaces the page while keeping the stream and ownership controls connected. */
  readonly pageOverlay?: ReactNode;
  readonly className?: string;
  readonly ref?: Ref<ServerBrowserHandle>;
}) {
  const {
    environmentId,
    threadId,
    tabId,
    visible,
    followSize = true,
    controlPosition = "top",
    onFirstFrame,
    onViewport,
    onControl,
    pageOverlay,
    className,
    ref,
  } = props;
  const access = usePreviewStreamAccess(environmentId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const keySentRef = useRef(false);
  const clientRef = useRef<PreviewStreamClient | null>(null);
  const viewportRef = useRef<PreviewStreamViewport | null>(null);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const hasFrameRef = useRef(false);
  const controlRef = useRef<PreviewStreamControl | null>(null);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const [promptText, setPromptText] = useState("");
  const [fileChooser, setFileChooser] = useState<PreviewStreamFileChooser | null>(null);
  const [agentCursor, setAgentCursor] = useState<AgentCursorPlacement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const answerFileChooser = (files: ReadonlyArray<File>) => {
    const chooser = fileChooser;
    if (!chooser) return;
    setFileChooser(null);
    void uploadPreviewStreamFiles(chooser, files).catch((cause: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not send the files to the page",
        description: cause instanceof Error ? cause.message : undefined,
      }),
    );
  };
  const unauthorizedRef = useRef(0);
  const [accessDenied, setAccessDenied] = useState(false);
  const [hostSetup, setHostSetup] = useState<PreviewStreamHostSetup | null>(null);
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
  const controlChanged = useEffectEvent((next: PreviewStreamControl | null) => onControl?.(next));
  // Frame cap in device px, fixed per socket. It grows with the surface and
  // never shrinks, so only outgrowing it reconnects.
  const [cap, setCap] = useState<{ width: number; height: number } | null>(null);

  const send = useCallback((input: PreviewStreamInput) => {
    clientRef.current?.send(input);
  }, []);

  const clearInput = useCallback(() => {
    if (inputFrameRef.current !== null) cancelAnimationFrame(inputFrameRef.current);
    inputFrameRef.current = null;
    pendingMoveRef.current = pendingWheelRef.current = null;
    mouseButtonsRef.current = 0;
    mouseClicksRef.current = { left: 1, middle: 1, right: 1, none: 1 };
    lastClickRef.current = null;
    touchRef.current = probeRef.current = lastProbeRef.current = null;
    keySentRef.current = false;
    if (inputRef.current) inputRef.current.value = INPUT_SENTINEL;
    inputRef.current?.blur();
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

  // Coalesce moves and wheel deltas to one message each per animation frame.
  const scheduleFlush = useCallback(() => {
    inputFrameRef.current ??= requestAnimationFrame(flushInput);
  }, [flushInput]);

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
      if (!canvas || !viewport || !hasFrameRef.current || controlRef.current?.controller !== "you")
        return null;
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

  useImperativeHandle(
    ref,
    () => ({
      navigate: (url) => send({ type: "navigate", url }),
      history: (delta) => send({ type: "history", delta }),
      reload: (options) =>
        send({ type: "reload", ...(options?.ignoreCache ? { ignoreCache: true } : {}) }),
      viewport: (setting) => send({ type: "viewport", setting }),
      canvas: () => (hasFrameRef.current ? canvasRef.current : null),
    }),
    [send],
  );

  useEffect(() => {
    const element = canvasRef.current?.parentElement;
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
    if (!visible || accessDenied || hostSetup || !access || !cap || !canvas) return;
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
          if (controlRef.current?.controller !== "you") return;
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
        onPointer: (pointer) => {
          const placed = placeAgentCursor(pointer, canvasRef.current, viewportRef.current);
          if (placed) setAgentCursor(placed);
        },
        onClipboard: (text) => void copyPageText(text),
        onDownload: offerDownload,
        onFileChooser: setFileChooser,
        onViewport: (viewport) => {
          viewportRef.current = viewport;
          viewportChanged(viewport);
        },
        onControl: (next) => {
          const previous = controlRef.current;
          controlRef.current = next;
          setControl(next);
          controlChanged(next);
          if (
            next.dialog?.message !== previous?.dialog?.message ||
            next.dialog?.defaultValue !== previous?.dialog?.defaultValue
          )
            setPromptText(next.dialog?.defaultValue ?? "");
          if (next.controller !== "you") {
            clearInput();
          } else if (previous?.controller !== "you") {
            const size = sizeRef.current;
            if (followSize && size) client.send({ type: "resize", ...size });
          }
        },
        onConnectedChange: (connected) => {
          if (connected) return;
          setFileChooser(null);
          controlRef.current = null;
          setControl(null);
          controlChanged(null);
          clearInput();
        },
        onHostSetup: setHostSetup,
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
      controlRef.current = null;
      setControl(null);
      controlChanged(null);
      clearInput();
    };
  }, [
    access,
    accessDenied,
    cap,
    clearInput,
    environmentId,
    followSize,
    hostSetup,
    tabId,
    threadId,
    visible,
  ]);

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

  const handlePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (controlRef.current?.controller !== "you") return;
    const { type, pointerId, clientX, clientY } = event;
    const cancelled = type === "pointercancel";
    const touch = touchRef.current;
    if (cancelled && touch?.pointerId === pointerId) {
      touchRef.current = probeRef.current = null;
      return;
    }
    if (event.pointerType === "touch" && !cancelled) {
      const point = pagePoint(clientX, clientY, type === "pointermove");
      if (type === "pointerdown") {
        if (!event.isPrimary) return;
        touchRef.current = {
          pointerId,
          startX: clientX,
          startY: clientY,
          lastX: clientX,
          lastY: clientY,
          panning: false,
        };
        const last = lastProbeRef.current;
        const reusable =
          point &&
          last &&
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
      if (!touch || touch.pointerId !== pointerId) return;
      if (type === "pointermove") {
        if (
          !touch.panning &&
          Math.hypot(clientX - touch.startX, clientY - touch.startY) < TAP_SLOP_PX
        )
          return;
        touch.panning = true;
        if (point)
          queueWheel(
            point,
            (touch.lastX - clientX) * point.scale,
            (touch.lastY - clientY) * point.scale,
            0,
          );
        touch.lastX = clientX;
        touch.lastY = clientY;
        return;
      }
      touchRef.current = null;
      const probe = probeRef.current;
      if (touch.panning) {
        probeRef.current = null;
        return;
      }
      if (!point) return;
      // iOS requires focus during the tap; late probe replies only raise Android's keyboard.
      if (probe?.editable === true) focusInput();
      else if (probe?.editable === false) inputRef.current?.blur();
      if (probe && !probe.answered) probe.tapped = true;
      else probeRef.current = null;
      flushInput();
      const clickCount = countClick("left", clientX, clientY, event.timeStamp);
      const at = { x: point.x, y: point.y, modifiers: 0 };
      send({ type: "mouse", action: "move", ...at, button: "none", buttons: 0, clickCount: 0 });
      send({ type: "mouse", action: "down", ...at, button: "left", buttons: 1, clickCount });
      send({ type: "mouse", action: "up", ...at, button: "left", buttons: 0, clickCount });
      return;
    }
    const previous = mouseButtonsRef.current;
    if ((cancelled || type === "pointerup") && previous === 0) return;
    if (cancelled || type === "pointerup")
      mouseButtonsRef.current = cancelled ? 0 : event.buttons & 7;
    const point = pagePoint(
      clientX,
      clientY,
      type !== "pointerdown" &&
        (cancelled || type === "pointerup" || previous !== 0 || event.buttons !== 0),
    );
    if (!point) return;
    const at = { x: point.x, y: point.y, modifiers: previewStreamModifiers(event) };
    const mouse = (action: "down" | "up", button: PreviewStreamMouseButton, buttons: number) => {
      if (action === "down")
        mouseClicksRef.current[button] = countClick(button, clientX, clientY, event.timeStamp);
      send({
        type: "mouse",
        action,
        ...at,
        button,
        buttons,
        clickCount: mouseClicksRef.current[button],
      });
    };
    if (type === "pointerdown") {
      focusInput();
      event.currentTarget.setPointerCapture(pointerId);
      flushInput();
      mouseButtonsRef.current = event.buttons & 7;
      mouse("down", buttonOf(event.button), event.buttons);
    } else if (type === "pointerup") {
      flushInput();
      mouse("up", buttonOf(event.button), event.buttons);
    } else {
      // Chords arrive as pointermove. Cancellation releases every held button.
      const next = cancelled ? 0 : event.buttons & 7;
      const changed = previous ^ next;
      if (previous !== 0 && changed !== 0) {
        flushInput();
        let buttons = previous;
        for (const bit of [1, 2, 4]) {
          if (!(changed & bit)) continue;
          buttons ^= bit;
          mouse(next & bit ? "down" : "up", pressedButtonOf(bit), buttons);
        }
        mouseButtonsRef.current = next;
      }
      if (cancelled) return;
      pendingMoveRef.current = {
        type: "mouse",
        action: "move",
        ...at,
        button: pressedButtonOf(event.buttons),
        buttons: event.buttons,
        clickCount: 0,
      };
      scheduleFlush();
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
    if (controlRef.current?.controller !== "you") return;
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
    // Paste arrives as a paste event carrying this device's clipboard. Copy and cut run
    // in the page, which sends the copied text back. Shift+Insert is the same paste.
    if (shortcut && event.key.toLowerCase() === "v") return;
    if (event.shiftKey && event.key === "Insert") return;
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
      const text = textarea.value.replace(/^\u200b/, "");
      if (text) send({ type: "text", text });
    }
    resetInput(textarea);
  };

  return (
    <div
      className={cn("relative flex flex-col overflow-hidden", className)}
      data-server-browser-surface={tabId}
    >
      <div
        className={cn(
          "visible relative z-20 flex shrink-0 items-center justify-between gap-2 border-border bg-background px-2 py-1",
          controlPosition === "bottom" ? "order-last border-t" : "border-b",
        )}
      >
        <span role="status" className="text-xs text-muted-foreground">
          {previewStreamControlLabel(control)}
        </span>
        {control?.canOperate ? (
          <Button
            variant="outline"
            size="xs"
            disabled={control.controller === "another-viewer"}
            onClick={() =>
              send({ type: control.controller === "you" ? "releaseControl" : "takeControl" })
            }
          >
            {control.controller === "you" ? "Release control" : "Take control"}
          </Button>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          className={cn("block size-full touch-none object-contain", pageOverlay && "invisible")}
          onPointerDown={handlePointer}
          onPointerMove={handlePointer}
          onPointerUp={handlePointer}
          onPointerCancel={handlePointer}
          // Keeps focus in the page input below and stops native text selection.
          onMouseDown={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
        />
        {agentCursor && control?.controller !== "you" ? (
          <AgentCursorMark
            {...agentCursor}
            controller={control?.controller === "agent" ? "agent" : "none"}
          />
        ) : null}
        {pageOverlay ? <div className="absolute inset-0 z-10">{pageOverlay}</div> : null}
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
          disabled={control?.controller !== "you"}
          defaultValue={INPUT_SENTINEL}
          // The caret must sit after the sentinel for a deletion to have something to delete.
          onFocus={(event) => resetInput(event.currentTarget)}
          className="sr-only top-0 left-0 text-base"
          onKeyDown={(event) => handleKey("down", event)}
          onKeyUp={(event) => handleKey("up", event)}
          onInput={handleInput}
          onCompositionEnd={(event) => {
            const text = event.data.replace(/^\u200b/, "");
            if (text) send({ type: "text", text });
            resetInput(event.currentTarget);
          }}
          // Copying the input would put its sentinel on this device's clipboard.
          onCopy={(event) => event.preventDefault()}
          onCut={(event) => event.preventDefault()}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            if (text) send({ type: "text", text });
          }}
        />
        {fileChooser && control?.controller === "you" ? (
          <div
            className="absolute inset-x-2 top-2 z-10 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg"
            role="dialog"
            aria-label="Choose files for the page"
          >
            <p className="text-sm">
              The page asks for {fileChooser.multiple ? "files" : "a file"}.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple={fileChooser.multiple}
              accept={fileChooser.accept}
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = "";
                if (files.length > 0) answerFileChooser(files);
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => answerFileChooser([])}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                Choose {fileChooser.multiple ? "files" : "file"}
              </Button>
            </div>
          </div>
        ) : null}
        {control?.dialog ? (
          <div
            className="absolute inset-x-2 top-2 z-10 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg"
            role="dialog"
            aria-label="Browser dialog"
          >
            <p className="break-words text-sm">{control.dialog.message}</p>
            {control.controller === "you" ? (
              <>
                {control.dialog.type === "prompt" ? (
                  <Input
                    aria-label="Dialog response"
                    value={promptText}
                    onChange={(event) => setPromptText(event.target.value)}
                  />
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => send({ type: "dialog", accept: false })}
                  >
                    Dismiss
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      send({
                        type: "dialog",
                        accept: true,
                        ...(control.dialog?.type === "prompt" ? { promptText } : {}),
                      })
                    }
                  >
                    Accept
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Take control to respond.</p>
            )}
          </div>
        ) : null}
      </div>
      {visible && hostSetup ? (
        <div className="visible absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background p-4 text-center">
          <p role="alert" className="max-w-sm text-sm text-muted-foreground">
            {previewStreamHostSetupMessage(hostSetup)}
          </p>
          <CommandBlock command={hostSetup.command} className="w-full max-w-md text-left" />
          <Button variant="outline" size="sm" onClick={() => setHostSetup(null)}>
            Try again
          </Button>
        </div>
      ) : null}
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

interface AgentCursorPlacement {
  readonly phase: PreviewStreamPointer["phase"];
  readonly sequence: number;
  readonly left: number;
  readonly top: number;
}

/** Places the agent cursor over the letterboxed frame, the inverse of the viewer's own pointer mapping. */
function placeAgentCursor(
  pointer: PreviewStreamPointer,
  canvas: HTMLCanvasElement | null,
  viewport: PreviewStreamViewport | null,
): AgentCursorPlacement | null {
  if (!canvas || !viewport || canvas.width < 1 || canvas.height < 1) return null;
  const box = { width: canvas.clientWidth, height: canvas.clientHeight };
  const fit = Math.min(box.width / canvas.width, box.height / canvas.height);
  const width = canvas.width * fit;
  const height = canvas.height * fit;
  return {
    phase: pointer.phase,
    sequence: pointer.sequence,
    left: (box.width - width) / 2 + (pointer.x * width) / viewport.width,
    top: (box.height - height) / 2 + (pointer.y * height) / viewport.height,
  };
}
