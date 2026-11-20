import {
  GUEST_MESSAGE_MAX_ATTACHMENT_BYTES,
  GUEST_MESSAGE_MAX_ATTACHMENTS,
  isProviderSendTurnSupportedImageMimeType,
} from "@t3tools/contracts";
import { markdownDestinationHostPath } from "@t3tools/shared/markdownLinks";
import { chatMarkdownImageSources } from "@t3tools/shared/markdownPipeline";
import { isAbsolutePath, isNetworkPath } from "@t3tools/shared/path";

/** A file from a guest's message request, saved by the multipart parser to a temporary path. */
export interface GuestUpload {
  readonly name: string;
  readonly contentType: string;
  readonly path: string;
}

/** What the server learned about an upload before deciding what it may become. */
export interface InspectedGuestUpload {
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** The first bytes of the file. */
  readonly header: Uint8Array;
}

export type GuestUploadRejection = "too_many_files" | "too_large" | "unsupported_file";

/** An attachment before it is stored and gets its id. */
export interface GuestAttachmentDraft {
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** Bytes of the file the signature check reads. */
export const GUEST_UPLOAD_HEADER_BYTES = 12;

const startsWith = (header: Uint8Array, bytes: ReadonlyArray<number>, offset = 0) =>
  bytes.every((byte, index) => header[offset + index] === byte);
const ascii = (text: string) => Array.from(text, (character) => character.charCodeAt(0));

/** An image must be what its type says, so a renamed HTML page never travels as one. */
const IMAGE_SIGNATURES: Readonly<Record<string, (header: Uint8Array) => boolean>> = {
  "image/png": (header) => startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (header) => startsWith(header, [0xff, 0xd8, 0xff]),
  "image/gif": (header) => startsWith(header, ascii("GIF8")),
  "image/webp": (header) =>
    startsWith(header, ascii("RIFF")) && startsWith(header, ascii("WEBP"), 8),
};

export const matchesImageSignature = (mimeType: string, header: Uint8Array) =>
  IMAGE_SIGNATURES[mimeType]?.(header) === true;

const IMAGE_TYPE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);

/**
 * The type of a host image a guest may ask for by path, or null. A network path never qualifies:
 * it would make the host reach out to another machine.
 */
export function guestHostImageType(path: string): string | null {
  if (!isAbsolutePath(path) || isNetworkPath(path)) return null;
  return IMAGE_TYPE_BY_EXTENSION.get(path.split(".").at(-1)!.toLowerCase()) ?? null;
}

/**
 * Whether an agent reply shows the image at `path`, so the guest already sees it. `imageSources`
 * lets the caller reuse a reply's parse across requests.
 */
export function repliesShowImage<Reply extends { readonly text: string }>(
  path: string,
  replies: ReadonlyArray<Reply>,
  imageSources: (reply: Reply) => ReadonlyArray<string> = (reply) =>
    chatMarkdownImageSources(reply.text),
) {
  // Parsing is the slow part; a reply with no image syntax shows no image.
  return replies.some(
    (reply) =>
      (reply.text.includes("![") || /<img/i.test(reply.text)) &&
      imageSources(reply).some((source) => markdownDestinationHostPath(source) === path),
  );
}

/**
 * Control characters and separators would break the name in headers and on disk, and direction
 * overrides would let `invoice\u202Efdp.exe` show as a PDF.
 */
const safeName = (name: string, fallback: string) =>
  name
    .replace(/[\p{Cc}\\/\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "_")
    .trim()
    .slice(0, 255) || fallback;

/**
 * The attachments a guest's files become, as the owner's composer takes them: supported images as
 * images, anything else that is not an image as a file. Other image types (SVG, HEIC) and empty
 * files are refused, as are too many files or too many bytes in one message.
 */
export function classifyGuestUploads(
  uploads: ReadonlyArray<InspectedGuestUpload>,
):
  | { readonly ok: true; readonly attachments: ReadonlyArray<GuestAttachmentDraft> }
  | { readonly ok: false; readonly reason: GuestUploadRejection } {
  if (uploads.length > GUEST_MESSAGE_MAX_ATTACHMENTS)
    return { ok: false, reason: "too_many_files" };
  const total = uploads.reduce((sum, upload) => sum + upload.sizeBytes, 0);
  if (total > GUEST_MESSAGE_MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too_large" };
  const attachments: Array<GuestAttachmentDraft> = [];
  for (const upload of uploads) {
    const mimeType =
      upload.contentType.split(";", 1)[0]!.trim().toLowerCase() || "application/octet-stream";
    if (upload.sizeBytes === 0) return { ok: false, reason: "unsupported_file" };
    if (mimeType.startsWith("image/")) {
      if (
        !isProviderSendTurnSupportedImageMimeType(mimeType) ||
        !matchesImageSignature(mimeType, upload.header)
      ) {
        return { ok: false, reason: "unsupported_file" };
      }
      attachments.push({
        type: "image",
        name: safeName(upload.name, "image"),
        mimeType,
        sizeBytes: upload.sizeBytes,
      });
      continue;
    }
    attachments.push({
      type: "file",
      name: safeName(upload.name, "file"),
      mimeType: mimeType.length <= 100 ? mimeType : "application/octet-stream",
      sizeBytes: upload.sizeBytes,
    });
  }
  return { ok: true, attachments };
}
