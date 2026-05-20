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

export const MIME_TYPE_BY_IMAGE_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
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

export function imageExtensionFromFileName(fileName: string): string | null {
  const extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(fileName.trim());
  const extension = extensionMatch ? `.${extensionMatch[1]!.toLowerCase()}` : "";
  return SAFE_IMAGE_FILE_EXTENSIONS.has(extension) ? extension : null;
}

export function imageMimeTypeFromFileName(fileName: string): string | null {
  const extension = imageExtensionFromFileName(fileName);
  if (!extension) {
    return null;
  }
  return Object.hasOwn(MIME_TYPE_BY_IMAGE_EXTENSION, extension)
    ? (MIME_TYPE_BY_IMAGE_EXTENSION[extension] ?? null)
    : null;
}

export function isSafeImageFileName(fileName: string): boolean {
  return imageMimeTypeFromFileName(fileName) !== null;
}
