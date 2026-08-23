/**
 * Pure model behind the preview screenshot annotation editor: numbered
 * markers and boxes over a captured image, each carrying a text note.
 * Coordinates are normalized (0..1) against the displayed image so the
 * flattened capture and the note text never depend on device pixel sizes.
 */
import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import { estimateBase64ByteSize } from "../../lib/base64";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { uuidv4 } from "../../lib/uuid";

export interface PreviewAnnotationMarker {
  readonly id: string;
  /** 1-based badge number, always contiguous with the marker's list position. */
  readonly index: number;
  readonly kind: "pin" | "box";
  /** Normalized top-left corner (0..1) of the marker within the image. */
  readonly x: number;
  readonly y: number;
  /** Normalized size (0..1). Pins have zero size. */
  readonly width: number;
  readonly height: number;
  readonly note: string;
}

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

const renumber = (
  markers: ReadonlyArray<PreviewAnnotationMarker>,
): ReadonlyArray<PreviewAnnotationMarker> =>
  markers.map((marker, position) => ({ ...marker, index: position + 1 }));

export function addPinMarker(
  markers: ReadonlyArray<PreviewAnnotationMarker>,
  point: { readonly x: number; readonly y: number },
): ReadonlyArray<PreviewAnnotationMarker> {
  return renumber([
    ...markers,
    {
      id: uuidv4(),
      index: markers.length + 1,
      kind: "pin",
      x: clampUnit(point.x),
      y: clampUnit(point.y),
      width: 0,
      height: 0,
      note: "",
    },
  ]);
}

/** Boxes can be dragged from any corner; store the normalized top-left rect. */
export function addBoxMarker(
  markers: ReadonlyArray<PreviewAnnotationMarker>,
  rect: {
    readonly startX: number;
    readonly startY: number;
    readonly endX: number;
    readonly endY: number;
  },
): ReadonlyArray<PreviewAnnotationMarker> {
  const left = clampUnit(Math.min(rect.startX, rect.endX));
  const top = clampUnit(Math.min(rect.startY, rect.endY));
  const right = clampUnit(Math.max(rect.startX, rect.endX));
  const bottom = clampUnit(Math.max(rect.startY, rect.endY));
  return renumber([
    ...markers,
    {
      id: uuidv4(),
      index: markers.length + 1,
      kind: "box",
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      note: "",
    },
  ]);
}

export function removeMarker(
  markers: ReadonlyArray<PreviewAnnotationMarker>,
  id: string,
): ReadonlyArray<PreviewAnnotationMarker> {
  return renumber(markers.filter((marker) => marker.id !== id));
}

export function updateMarkerNote(
  markers: ReadonlyArray<PreviewAnnotationMarker>,
  id: string,
  note: string,
): ReadonlyArray<PreviewAnnotationMarker> {
  return markers.map((marker) => (marker.id === id ? { ...marker, note } : marker));
}

/**
 * The text appended to the composer draft alongside the flattened screenshot.
 * Numbers match the badges baked into the image.
 */
export function buildPreviewAnnotationText(input: {
  readonly pageUrl: string;
  readonly markers: ReadonlyArray<PreviewAnnotationMarker>;
}): string {
  const lines = [`Annotated preview screenshot of ${input.pageUrl} (attached):`];
  for (const marker of input.markers) {
    const note = marker.note.trim();
    lines.push(`${marker.index}. ${note.length > 0 ? note : "(see marker in screenshot)"}`);
  }
  return lines.join("\n");
}

export type PreviewAnnotationAttachmentResult =
  | { readonly ok: true; readonly attachment: DraftComposerImageAttachment }
  | { readonly ok: false; readonly error: string };

/**
 * Wrap a flattened PNG capture in the standard composer attachment shape,
 * enforcing the same count and size limits as every other image attachment.
 */
export function buildPreviewAnnotationAttachment(input: {
  readonly base64: string;
  readonly existingAttachmentCount: number;
}): PreviewAnnotationAttachmentResult {
  if (input.existingAttachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return {
      ok: false,
      error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`,
    };
  }
  const mimeType = "image/png";
  if (!isProviderSendTurnSupportedImageMimeType(mimeType)) {
    return { ok: false, error: "Screenshots must be PNG images." };
  }
  const sizeBytes = estimateBase64ByteSize(input.base64);
  if (sizeBytes <= 0) {
    return { ok: false, error: "The screenshot capture came back empty." };
  }
  if (sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    return { ok: false, error: "The screenshot is too large to attach." };
  }
  const dataUrl = `data:${mimeType};base64,${input.base64}`;
  return {
    ok: true,
    attachment: {
      id: uuidv4(),
      type: "image",
      name: "preview-annotation.png",
      mimeType,
      sizeBytes,
      dataUrl,
      previewUri: dataUrl,
    },
  };
}
