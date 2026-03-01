import Mime from "@effect/platform-node/Mime";

export const ATTACHMENTS_ROUTE_PREFIX = "/attachments";

export const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
};

export const SAFE_IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
]);

export function parseBase64DataUrl(
  dataUrl: string,
): { readonly mimeType: string; readonly base64: string } | null {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(dataUrl.trim());
  if (!match) return null;

  const mimeType = match[1]?.trim().toLowerCase();
  const base64 = match[2]?.replace(/\s+/g, "");
  if (!mimeType || !base64) return null;

  return { mimeType, base64 };
}

export function inferImageExtension(input: { mimeType: string; fileName?: string }): string {
  const fromMime = IMAGE_EXTENSION_BY_MIME_TYPE[input.mimeType.toLowerCase()];
  if (fromMime) {
    return fromMime;
  }

  const fromMimeExtension = Mime.getExtension(input.mimeType);
  if (fromMimeExtension && SAFE_IMAGE_FILE_EXTENSIONS.has(fromMimeExtension)) {
    return fromMimeExtension;
  }

  const fileName = input.fileName?.trim() ?? "";
  const extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  const fileNameExtension = extensionMatch ? `.${extensionMatch[1]!.toLowerCase()}` : "";
  if (SAFE_IMAGE_FILE_EXTENSIONS.has(fileNameExtension)) {
    return fileNameExtension;
  }

  return ".bin";
}
