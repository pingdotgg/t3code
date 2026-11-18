import type { WebContents } from "electron";

import { ANNOTATION_REGION_CAPTURE_CHANNEL } from "./GuestProtocol.ts";

type Rect = { x: number; y: number; width: number; height: number };

const JPEG_QUALITY = 80;

const toRect = (value: unknown): Rect | null => {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  const rect = { x, y, width, height } as Rect;
  return rect.width > 0 && rect.height > 0 ? rect : null;
};

/**
 * Copies the guest's composited pixels for a viewport rect in CSS px. The copy runs in the
 * GPU process, so the page's main thread never waits on it, and it shows what is on screen,
 * including fixed and top-layer content a DOM render loses.
 */
export function attachAnnotationRegionCapture(guest: WebContents): void {
  guest.ipc.removeHandler(ANNOTATION_REGION_CAPTURE_CHANNEL);
  guest.ipc.handle(ANNOTATION_REGION_CAPTURE_CHANNEL, async (_event, raw: unknown) => {
    const rect = toRect(raw);
    if (rect === null || guest.isDestroyed()) return null;
    // capturePage takes DIPs; page zoom scales CSS px to DIPs.
    const zoom = guest.getZoomFactor();
    const image = await guest.capturePage({
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.max(1, Math.round(rect.width * zoom)),
      height: Math.max(1, Math.round(rect.height * zoom)),
    });
    if (image.isEmpty()) return null;
    return `data:image/jpeg;base64,${image.toJPEG(JPEG_QUALITY).toString("base64")}`;
  });
}
