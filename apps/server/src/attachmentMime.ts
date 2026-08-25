import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

export const DOCUMENT_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "application/pdf": ".pdf",
};

export const SAFE_DOCUMENT_FILE_EXTENSIONS = new Set([".pdf"]);

export const SAFE_ATTACHMENT_FILE_EXTENSIONS = new Set([
  ...SAFE_IMAGE_FILE_EXTENSIONS,
  ...SAFE_DOCUMENT_FILE_EXTENSIONS,
]);

export function isDocumentMimeType(mimeType: string): boolean {
  return Object.hasOwn(DOCUMENT_EXTENSION_BY_MIME_TYPE, mimeType.trim().toLowerCase());
}

export function inferDocumentExtension(input: { mimeType: string; fileName?: string }): string {
  const fromMime = DOCUMENT_EXTENSION_BY_MIME_TYPE[input.mimeType.trim().toLowerCase()];
  if (fromMime) {
    return fromMime;
  }
  const extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(input.fileName?.trim() ?? "");
  const fileNameExtension = extensionMatch ? `.${extensionMatch[1]!.toLowerCase()}` : "";
  return SAFE_DOCUMENT_FILE_EXTENSIONS.has(fileNameExtension) ? fileNameExtension : ".bin";
}

/**
 * Stored-file extension for an upload that only carries a mime type and a
 * filename. The upload token predates the attachment record, so the kind has
 * to be recovered from the mime type rather than a discriminant.
 */
export function inferAttachmentExtension(input: { mimeType: string; fileName?: string }): string {
  return isDocumentMimeType(input.mimeType)
    ? inferDocumentExtension(input)
    : inferImageExtension(input);
}

/**
 * Rejection text for providers whose turn payload only models images. Kept
 * here so every adapter tells the user the same thing and names a way out.
 */
export function documentAttachmentUnsupportedDetail(input: {
  readonly providerLabel: string;
  readonly fileName: string;
}): string {
  return `${input.providerLabel} does not accept document attachments. Remove '${input.fileName}' and try again, or send it to a provider that supports PDFs, such as Claude or OpenCode.`;
}
