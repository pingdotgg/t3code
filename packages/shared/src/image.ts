// Match PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES so unsupported images remain sendable as files.
const IMAGE_MIME_TYPE_BY_EXTENSION = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

const SUPPORTED_IMAGE_MIME_TYPES = new Set(IMAGE_MIME_TYPE_BY_EXTENSION.values());

export const GENERIC_MIME_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
]);

export function imageMimeType(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): string | null {
  const mimeType = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return mimeType;
  if (mimeType.startsWith("image/")) return null;
  // Infer from filenames only for missing or generic MIME types; extensions must not override a definite type.
  if (mimeType !== "" && !GENERIC_MIME_TYPES.has(mimeType)) return null;
  const dotIndex = attachment.name.lastIndexOf(".");
  return dotIndex < 0
    ? null
    : (IMAGE_MIME_TYPE_BY_EXTENSION.get(
        attachment.name
          .slice(dotIndex + 1)
          .trim()
          .toLowerCase(),
      ) ?? null);
}
