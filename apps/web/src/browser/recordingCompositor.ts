import type { DesktopPreviewRecordingInput } from "@t3tools/contracts";

import { readPreviewAnnotationTheme } from "./annotationTheme";

interface RecordingDecorationOptions {
  readonly showKeyPresses: boolean;
  readonly showMousePresses: boolean;
  readonly frameRate: number;
}

/** Decorates a detached canvas; no recording UI is inserted into the preview page. */
export async function createRecordingCompositor(
  source: MediaStream,
  options: RecordingDecorationOptions,
  subscribe: (listener: (input: DesktopPreviewRecordingInput) => void) => () => void,
) {
  if (!options.showKeyPresses && !options.showMousePresses) return null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Recording canvas is unavailable.");
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source;
  const settings = source.getVideoTracks()[0]?.getSettings();
  canvas.width = settings?.width ?? 1920;
  canvas.height = settings?.height ?? 1080;
  const decorations = new RecordingDecorations(options, readPreviewAnnotationTheme().primary);
  let disposed = false;
  let frameId: number | undefined;
  let timer: number | undefined;
  const draw = () => {
    if (disposed || video.readyState < 2) return;
    const width = video.videoWidth || canvas.width;
    const height = video.videoHeight || canvas.height;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    const now = performance.now();
    decorations.draw(context, width, height, now);
    window.clearTimeout(timer);
    const next = decorations.nextRedraw(now);
    if (next !== null) timer = window.setTimeout(draw, next);
  };
  const frame = () => {
    if (disposed) return;
    draw();
    frameId = video.requestVideoFrameCallback(frame);
  };
  const output = canvas.captureStream(options.frameRate);
  let unsubscribe: (() => void) | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    window.clearTimeout(timer);
    if (frameId !== undefined) video.cancelVideoFrameCallback(frameId);
    video.pause();
    video.srcObject = null;
    for (const track of output.getTracks()) track.stop();
  };
  try {
    unsubscribe = subscribe((input) => {
      decorations.apply(input, performance.now());
      draw();
    });
    frameId = video.requestVideoFrameCallback(frame);
    await video.play();
    draw();
    return { stream: output, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Keeps input timing and coordinates independent of native video frame delivery. */
export class RecordingDecorations {
  private ring: {
    x: number;
    y: number;
    width: number;
    height: number;
    held: boolean;
    releasedAt: number | null;
  } | null = null;
  private key: { label: string; width: number; expiresAt: number | null } | null = null;

  constructor(
    private readonly options: RecordingDecorationOptions,
    private readonly primaryColor: string,
  ) {}

  apply(input: DesktopPreviewRecordingInput, now: number) {
    if (input.type === "clear") {
      this.ring = null;
      this.key = null;
    } else if (input.type === "key" && this.options.showKeyPresses) {
      this.key = input.label
        ? { label: input.label, width: input.width, expiresAt: input.held ? null : now + 900 }
        : null;
    } else if (input.type === "pointer" && this.options.showMousePresses) {
      if (input.phase === "down" || input.phase === "click") {
        this.ring = {
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
          held: input.phase === "down",
          releasedAt: input.phase === "click" ? now : null,
        };
      } else if (this.ring?.held) {
        this.ring = {
          ...this.ring,
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
          held: input.phase !== "up",
          releasedAt: input.phase === "up" ? now : null,
        };
      }
    }
  }

  nextRedraw(now: number): number | null {
    if (
      this.ring?.releasedAt !== null &&
      this.ring?.releasedAt !== undefined &&
      now < this.ring.releasedAt + 600
    ) {
      return 1000 / this.options.frameRate;
    }
    return this.key?.expiresAt !== null &&
      this.key?.expiresAt !== undefined &&
      now < this.key.expiresAt
      ? this.key.expiresAt - now
      : null;
  }

  draw(context: CanvasRenderingContext2D, width: number, height: number, now: number) {
    // Guest coordinates are CSS pixels; native frames include zoom and display scale.
    const scale = width / (this.key?.width ?? this.ring?.width ?? 1280);
    const ring = this.ring;
    if (ring && (ring.held || (ring.releasedAt !== null && now < ring.releasedAt + 600))) {
      const progress = ring.releasedAt === null ? 0 : Math.min(1, (now - ring.releasedAt) / 600);
      context.save();
      const opacity = 0.9 * (1 - progress);
      context.strokeStyle = this.primaryColor;
      context.fillStyle = this.primaryColor;
      context.lineWidth = 2 * scale;
      context.beginPath();
      context.ellipse(
        (ring.x * width) / ring.width,
        (ring.y * height) / ring.height,
        ((20 * width) / ring.width) * (1 + progress * 0.5),
        ((20 * height) / ring.height) * (1 + progress * 0.5),
        0,
        0,
        Math.PI * 2,
      );
      context.globalAlpha = opacity * 0.15;
      context.fill();
      context.globalAlpha = opacity;
      context.stroke();
      context.restore();
    }
    const key = this.key;
    if (key && (key.expiresAt === null || now < key.expiresAt)) {
      context.save();
      context.font = `500 ${26 * scale}px system-ui, sans-serif`;
      const badgeWidth = Math.min(
        width - 32 * scale,
        context.measureText(key.label).width + 36 * scale,
      );
      const badgeHeight = 54 * scale;
      const left = (width - badgeWidth) / 2;
      const top = height - 24 * scale - badgeHeight;
      context.fillStyle = "rgba(32,32,34,.86)";
      context.beginPath();
      context.roundRect(left, top, badgeWidth, badgeHeight, 14 * scale);
      context.fill();
      context.fillStyle = "white";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(key.label, width / 2, top + badgeHeight / 2, badgeWidth - 24 * scale);
      context.restore();
    }
  }
}
