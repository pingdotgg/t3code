import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type EnvironmentId,
  type PullRequestRef,
  type PullRequestUploadAttachmentInput,
  type PullRequestUploadAttachmentResult,
} from "@t3tools/contracts";
import { runAttachmentUploadCycle, deletePendingAttachmentUpload } from "./state/attachments.ts";
import { runAtomCommand, squashAtomCommandFailure, type AtomCommand } from "./state/runtime.ts";

const MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;
export function reviewAttachmentMimeType(mimeType: string, name: string) {
  const aliases: Record<string, string> = {
    "image/jpg": "image/jpeg",
    "video/mov": "video/quicktime",
  };
  const extensions: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
  };
  const type =
    aliases[mimeType] ??
    (mimeType === "" || mimeType === "application/octet-stream"
      ? extensions[name.split(".").at(-1)?.toLowerCase() ?? ""]
      : mimeType);
  return MEDIA_TYPES.find((value) => value === type) ?? null;
}

/** Links and local media produce the same portable markdown on every client. */
export function reviewAttachmentMarkdown(input: { url: string; name?: string; mimeType?: string }) {
  const url = new URL(input.url.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Use an HTTP or HTTPS file link.");
  const name = (input.name?.trim() || "Attachment").replace(/[[\]\\\r\n]/g, " ");
  const href = url.href.replace(
    /[()<>]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const image =
    input.mimeType?.startsWith("image/") ?? /\.(png|jpe?g|gif|webp)(?:$|\?)/i.test(url.pathname);
  return image ? `![${name}](<${href}>)` : `[${name}](<${href}>)`;
}

/** The bytes stay in their destination environment until its provider publishes them. */
export async function publishReviewAttachment<E, RE, PE>(
  input: Parameters<typeof runAttachmentUploadCycle<E, RE>>[0] & {
    reference: PullRequestRef;
    isCancelled?: () => boolean;
    publish: AtomCommand<
      { environmentId: EnvironmentId; input: PullRequestUploadAttachmentInput },
      PullRequestUploadAttachmentResult,
      PE
    >;
  },
) {
  const { name, sizeBytes } = input.upload;
  const mimeType = reviewAttachmentMimeType(input.upload.mimeType, name);
  if (mimeType === null)
    throw new Error(
      "Choose a PNG, JPEG, GIF, WebP, MP4, MOV, or WebM file. Other files can be attached with a hosted link.",
    );
  if (sizeBytes <= 0 || sizeBytes > Math.min(PROVIDER_SEND_TURN_MAX_FILE_BYTES, 100 * 1024 * 1024))
    throw new Error("The selected attachment is empty or too large to upload.");
  const transferred = await runAttachmentUploadCycle(input);
  try {
    if (transferred.status !== "uploaded")
      throw transferred.status === "failed" ? transferred.error : new Error("Upload cancelled.");
    if (input.isCancelled?.()) throw new Error("Upload cancelled.");
    const result = await runAtomCommand(
      input.registry,
      input.publish,
      {
        environmentId: input.environmentId,
        input: {
          ...input.reference,
          attachmentId: transferred.attachmentId,
          name,
          mimeType,
          sizeBytes,
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return reviewAttachmentMarkdown({ url: result.value.url, name, mimeType });
  } finally {
    if (transferred.attachmentId !== null)
      deletePendingAttachmentUpload({
        registry: input.registry,
        remove: input.remove,
        environmentId: input.environmentId,
        attachmentId: transferred.attachmentId,
      });
  }
}
