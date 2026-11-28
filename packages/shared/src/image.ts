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
  // macOS and Windows label TypeScript `.ts` files as MPEG transport streams, which browsers can't play.
  "video/mp2t",
  "video/vnd.dlna.mpeg-tts",
]);

export function isSvgAttachment(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): boolean {
  const mimeType = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mimeType === "image/svg+xml" ||
    ((mimeType === "" || GENERIC_MIME_TYPES.has(mimeType)) && /\.svg$/i.test(attachment.name))
  );
}

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

// Providers reject an image whose declared type disagrees with its bytes, and the image stays in thread history.
export function imageMimeTypeFromBytes(bytes: Uint8Array): string | null {
  const startsWith = (signature: readonly number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  )
    return "image/gif";
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  return null;
}
