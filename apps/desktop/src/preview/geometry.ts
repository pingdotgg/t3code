import * as NodeZlib from "node:zlib";
import {
  DesktopPreviewRecordingInputSchema,
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
} from "@t3tools/contracts";
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  DesktopPreviewFavicon,
  DesktopPreviewOpenLinkEvent,
  DesktopPreviewPointerEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  PreviewAnnotationSubmissionResult,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  DesktopPreviewRecordingInputEvent,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewTabDefaults,
  PreviewForwardedShortcut,
} from "@t3tools/contracts";

export const ZOOM_LEVELS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

export const DEFAULT_ZOOM_FACTOR = 1.0;

export const ZOOM_EPSILON = 0.001;

export const RECORDING_ARM_GRACE_MS = 10_000;

export const PICTURE_IN_PICTURE_FRAME_INTERVAL_MS = Math.ceil(1_000 / 12);

export const PICTURE_IN_PICTURE_JPEG_QUALITY = 80;
// Cold guests can reject capturePage with UnknownVizError or stall; bound each attempt.

export const CAPTURE_PAGE_RETRY_ATTEMPTS = 3;

export const CAPTURE_PAGE_RETRY_DELAY_MS = 120;

export const CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS = 1_000;

export const PICTURE_IN_PICTURE_INITIAL_WIDTH = 480;

export const PICTURE_IN_PICTURE_INITIAL_HEIGHT = 320;

export const PICTURE_IN_PICTURE_MIN_WIDTH = 240;

export const PICTURE_IN_PICTURE_MIN_HEIGHT = 160;

export const PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON = 0.002;

export const MAX_ARTIFACT_SITE_SLUG_LENGTH = 80;

export const requestRecordingCaptureExpression = (tabId: string): string =>
  `globalThis[${JSON.stringify(DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER)}]?.(${JSON.stringify(tabId)}) === true`;

export const DEFAULT_ANNOTATION_THEME: DesktopPreviewAnnotationTheme = {
  colorScheme: "light",
  radius: "0.625rem",
  background: "white",
  foreground: "oklch(0.269 0 0)",
  popover: "white",
  popoverForeground: "oklch(0.269 0 0)",
  primary: "oklch(0.488 0.217 264)",
  primaryForeground: "white",
  muted: "rgb(0 0 0 / 4%)",
  mutedForeground: "oklch(0.556 0 0)",
  accent: "rgb(0 0 0 / 4%)",
  accentForeground: "oklch(0.269 0 0)",
  border: "rgb(0 0 0 / 8%)",
  input: "rgb(0 0 0 / 10%)",
  ring: "oklch(0.488 0.217 264)",
  fontSans: "system-ui, sans-serif",
  fontMono: "ui-monospace, monospace",
};

export const buildPreviewPictureInPictureDataUrl = (): string => {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    >
    <meta name="color-scheme" content="dark">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #111; }
      body { display: grid; place-items: center; }
      img { width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
    </style>
  </head>
  <body>
    <img id="preview-frame" alt="Live browser preview">
    <script>
      const frame = document.getElementById("preview-frame");
      window.previewPictureInPicture.onFrame((next) => {
        frame.src = "data:image/jpeg;base64," + next.data;
      });
    </script>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

export const fitPictureInPictureContentSize = (
  current: ReadonlyArray<number>,
  aspectRatio: number,
): readonly [width: number, height: number] => {
  const currentWidth = Math.max(1, current[0] ?? PICTURE_IN_PICTURE_INITIAL_WIDTH);
  const currentHeight = Math.max(1, current[1] ?? PICTURE_IN_PICTURE_INITIAL_HEIGHT);
  const currentArea = currentWidth * currentHeight;
  let width = Math.sqrt(currentArea * aspectRatio);
  let height = width / aspectRatio;
  const minimumScale = Math.max(
    1,
    PICTURE_IN_PICTURE_MIN_WIDTH / width,
    PICTURE_IN_PICTURE_MIN_HEIGHT / height,
  );
  width *= minimumScale;
  height *= minimumScale;
  return [Math.round(width), Math.round(height)];
};

export const recordingFileExtension = (mimeType: string): string => {
  const subtype = mimeType.split(";", 1)[0]?.trim().toLowerCase().split("/")[1] ?? "";
  const extension = subtype.replace(/^x-/, "").replace(/[^a-z0-9]/g, "");
  return extension || "video";
};

export const artifactSiteSlug = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    const slug = url.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_ARTIFACT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

export const normalizeCaptureRect = (value: unknown): PreviewAnnotationRect | null => {
  if (typeof value !== "object" || value === null) return null;
  const rect = value as Record<string, unknown>;
  const x = rect["x"];
  const y = rect["y"];
  const width = rect["width"];
  const height = rect["height"];
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
};

// capturePage returns a 1x NativeImage containing device pixels, so crop() uses
// CSS coordinates scaled by the guest's devicePixelRatio (including page zoom).

export const cropAnnotationScreenshot = (
  image: Electron.NativeImage,
  cropRect: PreviewAnnotationRect | null,
  devicePixelRatio: number,
  targetRects: ReadonlyArray<PreviewAnnotationRect>,
): PreviewAnnotationPayload["screenshot"] => {
  const full = image.getSize();
  if (full.width <= 0 || full.height <= 0) return null;
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  // Padding or a union of offscreen targets can overlap an empty viewport area.
  // A zero-width/height SVG line can still paint at the top or left edge.
  if (
    targetRects.length > 0 &&
    !targetRects.some(
      (rect) =>
        (rect.width > 0 || rect.height > 0) &&
        rect.x * scale < full.width &&
        rect.y * scale < full.height &&
        (rect.width === 0 ? rect.x >= 0 : rect.x + rect.width > 0) &&
        (rect.height === 0 ? rect.y >= 0 : rect.y + rect.height > 0),
    )
  ) {
    return null;
  }
  if (!cropRect) {
    return {
      dataUrl: image.toDataURL(),
      width: full.width,
      height: full.height,
      cropRect: { x: 0, y: 0, width: full.width, height: full.height },
    };
  }
  const x = Math.max(0, Math.floor(cropRect.x * scale));
  const y = Math.max(0, Math.floor(cropRect.y * scale));
  const right = Math.min(full.width, Math.ceil((cropRect.x + cropRect.width) * scale));
  const bottom = Math.min(full.height, Math.ceil((cropRect.y + cropRect.height) * scale));
  // A target scrolled out of view has no pixels in this capture. Clamping its
  // origin onto the edge would attach an unrelated strip as a successful crop.
  if (right <= x || bottom <= y) return null;
  const cropped = image.crop({
    x,
    y,
    width: right - x,
    height: bottom - y,
  });
  const size = cropped.getSize();
  if (size.width <= 0 || size.height <= 0) return null;
  return { dataUrl: cropped.toDataURL(), width: size.width, height: size.height, cropRect };
};

// An invalid color space skips costly P3-to-sRGB conversion; fingerprints need no color accuracy.

export const FINGERPRINT_BITMAP_OPTIONS: Electron.ToBitmapOptions = {
  colorSpace: { primaries: "invalid", transfer: "invalid", matrix: "invalid", range: "invalid" },
};

/** Empty readPixels results have no fingerprint and must be treated as changed frames. */

export const fingerprintCapturedFrame = (image: Electron.NativeImage, size: Electron.Size) => {
  let bitmap: Buffer;
  try {
    bitmap = image.toBitmap(FINGERPRINT_BITMAP_OPTIONS);
  } catch {
    return null;
  }
  if (bitmap.byteLength === 0) return null;
  return `${size.width}x${size.height}:${NodeZlib.crc32(bitmap)}`;
};

export const findZoomStep = (current: number): number => {
  const index = ZOOM_LEVELS.findIndex(
    (level) => Math.abs(level - current) < ZOOM_EPSILON || level > current,
  );
  if (index < 0) return ZOOM_LEVELS.length - 1;
  return Math.abs(ZOOM_LEVELS[index]! - current) < ZOOM_EPSILON ? index : index - 1;
};

export const normalizeZoomFactor = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR;
  let closest = ZOOM_LEVELS[0]!;
  for (const level of ZOOM_LEVELS) {
    if (Math.abs(level - value) < Math.abs(closest - value)) closest = level;
  }
  return closest;
};

export const nextZoomLevel = (current: number, direction: "in" | "out"): number => {
  const step = findZoomStep(current);
  if (direction === "in") {
    return ZOOM_LEVELS[Math.min(step + 1, ZOOM_LEVELS.length - 1)] ?? current;
  }
  return ZOOM_LEVELS[Math.max(step - 1, 0)] ?? current;
};
