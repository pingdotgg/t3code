/**
 * Anthropic rejects an image over 2000px on a side once a request holds more than 20 images, and
 * Claude Code forwards images sent into a running turn unchanged, so one large paste breaks
 * every later request in that thread.
 */
export const IMAGE_ATTACHMENT_MAX_EDGE = 2000;

export type DownscalableImageMimeType = "image/png" | "image/jpeg";

export function downscalableImageMimeType(mimeType: string): DownscalableImageMimeType | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  return null;
}

export function fitImageAttachmentSize(size: {
  readonly width: number;
  readonly height: number;
}): { width: number; height: number } | null {
  const longestEdge = Math.max(size.width, size.height);
  if (longestEdge <= IMAGE_ATTACHMENT_MAX_EDGE) return null;
  const scale = IMAGE_ATTACHMENT_MAX_EDGE / longestEdge;
  return {
    width: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.height * scale))),
  };
}
