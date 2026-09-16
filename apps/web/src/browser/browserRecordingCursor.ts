import type { DesktopPreviewPointerEvent, ScopedThreadRef } from "@t3tools/contracts";

import {
  agentBrowserCursorOpacity,
  type BrowserController,
} from "~/components/preview/agentBrowserCursorLogic";
import { readThreadPreviewState } from "~/previewStateStore";

import { useBrowserPointerStore } from "./browserPointerStore";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

/** How long a pointer event keeps the cursor fully opaque, matching the live overlay. */
export const BROWSER_RECORDING_CURSOR_ACTIVE_MS = 700;
/** How long the click ring expands after a click event. */
export const BROWSER_RECORDING_CURSOR_PING_MS = 600;
/** Upper bound on waiting for the first captured frame before falling back to the raw stream. */
const FIRST_FRAME_TIMEOUT_MS = 1_500;

/** Icon footprint in content-box CSS pixels, approximating the live overlay's icon size. */
const CURSOR_ICON_CSS_SIZE = 20;

/** Unit-space arrow outline relative to the tip, drawn at the recorded frame's pixel scale. */
const CURSOR_ARROW_UNITS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 0.74],
  [0.18, 0.58],
  [0.31, 0.88],
  [0.45, 0.82],
  [0.32, 0.53],
  [0.58, 0.53],
];

export interface RecordingCursorSource {
  readonly event: DesktopPreviewPointerEvent;
  readonly content: {
    readonly width: number;
    readonly height: number;
    readonly scale: number;
  };
  readonly zoomFactor: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly controller: BrowserController;
  readonly nowMs: number;
}

export interface RecordingCursorPlacement {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly opacity: number;
  readonly pingProgress: number | null;
}

const isPositiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;

const clamp = (value: number, bound: number): number =>
  Math.min(bound, Math.max(0, Number.isFinite(value) ? value : 0));

/**
 * Maps an agent pointer event from guest viewport CSS pixels into the captured
 * frame's pixel space. The captured frame is the full guest render, so the
 * cursor's relative position inside the content box is what matters; zoom and
 * presentation scale cancel out of the ratio.
 */
export function resolveRecordingCursorPlacement(
  source: RecordingCursorSource,
): RecordingCursorPlacement | null {
  const { event, content, zoomFactor, frameWidth, frameHeight, controller, nowMs } = source;
  if (
    !isPositiveFinite(frameWidth) ||
    !isPositiveFinite(frameHeight) ||
    !isPositiveFinite(content.width) ||
    !isPositiveFinite(content.height) ||
    !isPositiveFinite(content.scale) ||
    !isPositiveFinite(zoomFactor)
  ) {
    return null;
  }
  const x = clamp(event.x * zoomFactor * content.scale * (frameWidth / content.width), frameWidth);
  const y = clamp(
    event.y * zoomFactor * content.scale * (frameHeight / content.height),
    frameHeight,
  );
  const createdAt = Date.parse(event.createdAt);
  const ageMs = Number.isFinite(createdAt) ? Math.max(0, nowMs - createdAt) : 0;
  return {
    x,
    y,
    size: CURSOR_ICON_CSS_SIZE * (frameWidth / content.width),
    opacity: agentBrowserCursorOpacity(ageMs < BROWSER_RECORDING_CURSOR_ACTIVE_MS, controller),
    pingProgress:
      event.phase === "click" && ageMs < BROWSER_RECORDING_CURSOR_PING_MS
        ? ageMs / BROWSER_RECORDING_CURSOR_PING_MS
        : null,
  };
}

/**
 * Paints one cursor placement onto the recording canvas: a white arrow with its
 * tip at the pointer position, plus an expanding dark ring while a click is
 * fresh. Colors are fixed rather than themed so the cursor reads on any page.
 */
export function drawRecordingCursor(
  context: CanvasRenderingContext2D,
  placement: RecordingCursorPlacement,
): void {
  const { x, y, size, opacity, pingProgress } = placement;
  context.save();
  context.globalAlpha = opacity;
  context.beginPath();
  for (const [index, [unitX, unitY]] of CURSOR_ARROW_UNITS.entries()) {
    const pointX = x + unitX * size;
    const pointY = y + unitY * size;
    if (index === 0) context.moveTo(pointX, pointY);
    else context.lineTo(pointX, pointY);
  }
  context.closePath();
  context.fillStyle = "#ffffff";
  context.strokeStyle = "rgba(0, 0, 0, 0.85)";
  context.lineWidth = Math.max(1, size * 0.06);
  context.lineJoin = "round";
  context.fill();
  context.stroke();
  if (pingProgress !== null) {
    context.beginPath();
    context.arc(x + size * 0.4, y + size * 0.4, size * (0.2 + 0.6 * pingProgress), 0, Math.PI * 2);
    context.globalAlpha = opacity * 0.55 * (1 - pingProgress);
    context.lineWidth = Math.max(1, size * 0.07);
    context.strokeStyle = "rgba(0, 0, 0, 0.9)";
    context.stroke();
  }
  context.restore();
}

export interface FrameDrawRect {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Fits a captured frame into the recording canvas, centered with black bars.
 * The canvas keeps its start dimensions for the whole recording, so a guest
 * resize letterboxes instead of changing the video's dimensions mid-stream.
 */
export function resolveFrameDrawRect(
  canvasWidth: number,
  canvasHeight: number,
  frameWidth: number,
  frameHeight: number,
): FrameDrawRect | null {
  if (
    !isPositiveFinite(canvasWidth) ||
    !isPositiveFinite(canvasHeight) ||
    !isPositiveFinite(frameWidth) ||
    !isPositiveFinite(frameHeight)
  ) {
    return null;
  }
  const scale = Math.min(canvasWidth / frameWidth, canvasHeight / frameHeight);
  const width = frameWidth * scale;
  const height = frameHeight * scale;
  return {
    scale,
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
  };
}

export interface RecordingCursorCompositor {
  /** Stream to hand to the recorder instead of the raw capture. */
  readonly stream: MediaStream;
  readonly dispose: () => void;
}

/**
 * Pipes the raw tab capture through an offscreen canvas that has the agent
 * pointer composited on top of every frame. The canvas keeps the dimensions the
 * capture reported at start; later guest resizes are letterboxed so the recorded
 * video never changes dimensions mid-stream. Cursor animation is driven by
 * guest frames plus bounded timer redraws after pointer events, never a
 * continuous loop. Returns null when the environment cannot support the
 * pipeline or no frame arrives in time, in which case the recording falls back
 * to the raw stream.
 */
export const attachRecordingCursorCompositor = async (input: {
  readonly tabId: string;
  /** Server-local tab id, the namespace the preview overlay state is keyed by. */
  readonly serverTabId: string;
  readonly stream: MediaStream;
  readonly threadRef: ScopedThreadRef | null;
  readonly frameRate: number;
}): Promise<RecordingCursorCompositor | null> => {
  let video: HTMLVideoElement | null = null;
  try {
    const settings = input.stream.getVideoTracks()[0]?.getSettings();
    const canvasWidth = settings?.width;
    const canvasHeight = settings?.height;
    if (
      typeof canvasWidth !== "number" ||
      typeof canvasHeight !== "number" ||
      !isPositiveFinite(canvasWidth) ||
      !isPositiveFinite(canvasHeight)
    ) {
      return null;
    }
    video = document.createElement("video");
    if (typeof video.requestVideoFrameCallback !== "function") return null;
    const element = video;
    element.muted = true;
    element.srcObject = input.stream;

    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;

    let disposed = false;
    let frameHandle: number | null = null;
    let animationTimer: number | null = null;
    let animationDeadline = 0;
    let resolveFirstFrame: (() => void) | null = null;
    const firstFrame = new Promise<void>((resolve) => {
      resolveFirstFrame = resolve;
    });

    const draw = (): void => {
      const frameWidth = element.videoWidth;
      const frameHeight = element.videoHeight;
      const rect = resolveFrameDrawRect(canvasWidth, canvasHeight, frameWidth, frameHeight);
      if (!rect) return;
      context.fillStyle = "#000000";
      context.fillRect(0, 0, canvasWidth, canvasHeight);
      context.drawImage(element, rect.x, rect.y, rect.width, rect.height);

      const event = useBrowserPointerStore.getState().byTabId[input.tabId];
      const presentation = useBrowserSurfaceStore.getState().byTabId[input.tabId]?.content ?? null;
      const overlay = input.threadRef
        ? (readThreadPreviewState(input.threadRef).desktopByTabId[input.serverTabId] ?? null)
        : null;
      if (!event || !presentation) return;
      const placement = resolveRecordingCursorPlacement({
        event,
        content: presentation,
        zoomFactor: overlay?.zoomFactor ?? 1,
        frameWidth,
        frameHeight,
        controller: overlay?.controller ?? "none",
        nowMs: Date.now(),
      });
      if (!placement) return;
      drawRecordingCursor(context, {
        x: rect.x + placement.x * rect.scale,
        y: rect.y + placement.y * rect.scale,
        size: placement.size * rect.scale,
        opacity: placement.opacity,
        pingProgress: placement.pingProgress,
      });
    };

    const scheduleNextFrame = (): void => {
      if (disposed) return;
      frameHandle = element.requestVideoFrameCallback(() => {
        resolveFirstFrame?.();
        resolveFirstFrame = null;
        draw();
        scheduleNextFrame();
      });
    };
    scheduleNextFrame();

    const scheduleAnimation = (): void => {
      animationDeadline = Math.max(
        animationDeadline,
        Date.now() + Math.max(BROWSER_RECORDING_CURSOR_ACTIVE_MS, BROWSER_RECORDING_CURSOR_PING_MS),
      );
      if (animationTimer !== null) return;
      const interval = Math.max(16, Math.round(1_000 / input.frameRate));
      const tick = (): void => {
        animationTimer = null;
        draw();
        if (Date.now() < animationDeadline) {
          animationTimer = window.setTimeout(tick, interval);
        }
      };
      animationTimer = window.setTimeout(tick, interval);
    };
    let failed = false;
    let output: MediaStream | null = null;
    // Shared by dispose, the startup-failure path, and the catch below.
    let teardown: (() => void) | null = null;
    // Only this tab's pointer events may trigger redraws; agents driving other
    // tabs must not cause full-frame repaints of this recording.
    const unsubscribePointerEvents = useBrowserPointerStore.subscribe((state, previous) => {
      if (state.byTabId[input.tabId] !== previous.byTabId[input.tabId]) {
        draw();
        scheduleAnimation();
      }
    });
    teardown = () => {
      disposed = true;
      unsubscribePointerEvents();
      if (animationTimer !== null) window.clearTimeout(animationTimer);
      if (frameHandle !== null) element.cancelVideoFrameCallback(frameHandle);
      element.srcObject = null;
      for (const track of output?.getTracks() ?? []) track.stop();
    };

    try {
      // play() resolves only once a frame arrives; guest frames can be slow to
      // start, so bound the wait and fall back to the raw stream instead of
      // stalling recording startup.
      void element.play().catch(() => {
        if (resolveFirstFrame === null) return;
        failed = true;
        resolveFirstFrame();
        resolveFirstFrame = null;
      });
      const timeoutId = window.setTimeout(() => {
        // Timed out waiting for the first frame: fall back to the raw stream
        // rather than hand the recorder a canvas that may never paint.
        failed = true;
        resolveFirstFrame?.();
        resolveFirstFrame = null;
      }, FIRST_FRAME_TIMEOUT_MS);
      await firstFrame;
      window.clearTimeout(timeoutId);
      if (failed) return null;

      output = canvas.captureStream(input.frameRate);
      return {
        stream: output,
        dispose: () => teardown?.(),
      };
    } finally {
      // A captureStream throw leaves the loop and subscription with no owner.
      if (failed || output === null) teardown();
    }
  } catch {
    if (video) video.srcObject = null;
    return null;
  }
};
