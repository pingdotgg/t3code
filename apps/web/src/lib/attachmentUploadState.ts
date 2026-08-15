/**
 * Chip-level state for composer image attachments.
 *
 * Attachments upload the moment they are attached (paste / drop / picker), so
 * a chip is visible long before its bytes are on the server. The chip shows
 * upload progress as plain text — never a repainting spinner — and the send
 * button stays disabled until every chip has settled to `ready`.
 *
 * This module is deliberately dependency-free so the state machine can be
 * tested (and imported by the draft store) without pulling in the ws runtime.
 */
import type { EnvironmentId, ChatAttachment } from "@t3tools/contracts";

export type ComposerAttachmentUpload =
  /** Bytes are in flight. `progress` is 0..1. */
  | { readonly status: "uploading"; readonly progress: number }
  /**
   * Bytes are on the server. `attachmentId` is what the turn-start command
   * references; `environmentId` records where the bytes actually landed, so a
   * draft retargeted to another environment can detect the mismatch.
   */
  | {
      readonly status: "ready";
      readonly attachmentId: string;
      readonly environmentId: EnvironmentId;
    }
  /** Upload failed or was rejected. `reason` is short enough to render inline. */
  | { readonly status: "failed"; readonly reason: string };

/** Shown when a restored attachment belongs to a different environment. */
export const ATTACHMENT_WRONG_ENVIRONMENT_REASON = "Not in this environment";

/** Uploads allowed to run at once; the rest queue behind them. */
export const MAX_CONCURRENT_ATTACHMENT_UPLOADS = 3;

interface UploadableImage {
  readonly upload: ComposerAttachmentUpload;
}

/**
 * True for an uploaded attachment whose bytes live in a different environment
 * than the composer currently targets. This is a *derived* condition, never
 * written into the upload state: the ready state (with its attachmentId and
 * home environment) survives untouched, so pointing the draft back at the
 * bytes' environment makes the attachment sendable again with no re-upload.
 */
export function isAttachmentInWrongEnvironment(
  image: UploadableImage,
  environmentId: EnvironmentId,
): boolean {
  return image.upload.status === "ready" && image.upload.environmentId !== environmentId;
}

export interface AttachmentUploadSummary {
  /** Uploaded into the composer's current environment: sendable. */
  readonly ready: number;
  readonly uploading: number;
  readonly failed: number;
  /** Uploaded, but into a different environment: blocks send until resolved. */
  readonly wrongEnvironment: number;
}

export function summarizeAttachmentUploads(
  images: ReadonlyArray<UploadableImage>,
  environmentId: EnvironmentId,
): AttachmentUploadSummary {
  let ready = 0;
  let uploading = 0;
  let failed = 0;
  let wrongEnvironment = 0;
  for (const image of images) {
    if (image.upload.status === "ready") {
      if (image.upload.environmentId === environmentId) ready += 1;
      else wrongEnvironment += 1;
    } else if (image.upload.status === "uploading") uploading += 1;
    else failed += 1;
  }
  return { ready, uploading, failed, wrongEnvironment };
}

/**
 * Why the send button is disabled, or null when attachments are not blocking.
 * A failed or unreachable chip has to be retried or removed: silently
 * dropping it would send a message the user believes carries an image.
 */
export function attachmentUploadBlockReason(summary: AttachmentUploadSummary): string | null {
  if (summary.uploading > 0) {
    return summary.uploading === 1 ? "Image still uploading" : "Images still uploading";
  }
  if (summary.failed > 0) {
    return summary.failed === 1
      ? "Retry or remove the failed image"
      : "Retry or remove the failed images";
  }
  if (summary.wrongEnvironment > 0) {
    return summary.wrongEnvironment === 1
      ? "Remove the image from another environment"
      : "Remove the images from another environment";
  }
  return null;
}

/** Percent text drawn over an uploading chip. Rounded down so it never reads 100% early. */
export function formatAttachmentUploadProgress(progress: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return `${Math.floor(clamped * 100)}%`;
}

/**
 * Turn-start references for the images that actually made it to the server
 * *in the target environment*. Everything else is skipped: the send path is
 * gated on all-ready-here, so this only drops attachments that were never
 * sendable in the first place.
 */
export function readyAttachmentRefs(
  images: ReadonlyArray<
    UploadableImage & {
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
    }
  >,
  environmentId: EnvironmentId,
): ChatAttachment[] {
  return images.flatMap((image) =>
    image.upload.status === "ready" && image.upload.environmentId === environmentId
      ? [
          {
            type: "image" as const,
            id: image.upload.attachmentId,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
          },
        ]
      : [],
  );
}

/**
 * What to do with an attachment when the composer's target environment
 * changes. The bytes live in exactly one environment, so a ready attachment
 * pointing anywhere else has to be re-uploaded — possible only while the
 * original `File` is still in memory (it is not, after a reload). Without a
 * File the attachment is left untouched: the mismatch is *derived* for
 * display and send-gating (`isAttachmentInWrongEnvironment`), and switching
 * back to the bytes' environment restores it for free.
 */
export function resolveAttachmentEnvironmentAction(
  image: UploadableImage & { readonly file: File | null },
  targetEnvironmentId: EnvironmentId,
): "keep" | "reupload" {
  if (image.upload.status !== "ready") {
    return "keep";
  }
  if (image.upload.environmentId === targetEnvironmentId) {
    return "keep";
  }
  return image.file ? "reupload" : "keep";
}
