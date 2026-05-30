import Mime from "@effect/platform-node/Mime";
import {
  IMAGE_EXTENSION_BY_MIME_TYPE,
  MIME_TYPE_BY_IMAGE_EXTENSION,
  SAFE_IMAGE_FILE_EXTENSIONS,
  imageExtensionFromFileName as sharedImageExtensionFromFileName,
} from "@t3tools/shared/imageMime";

export { IMAGE_EXTENSION_BY_MIME_TYPE, MIME_TYPE_BY_IMAGE_EXTENSION, SAFE_IMAGE_FILE_EXTENSIONS };

export function imageExtensionFromFileName(fileName: string): string | null {
  return sharedImageExtensionFromFileName(fileName);
}

export function imageMimeTypeFromFileName(fileName: string): string | null {
  const extension = imageExtensionFromFileName(fileName);
  if (!extension) {
    return null;
  }
  if (Object.hasOwn(MIME_TYPE_BY_IMAGE_EXTENSION, extension)) {
    return MIME_TYPE_BY_IMAGE_EXTENSION[extension] ?? null;
  }
  const inferred = Mime.getType(fileName);
  return inferred?.startsWith("image/") ? inferred : null;
}

export function isSafeImageFileName(fileName: string): boolean {
  return imageMimeTypeFromFileName(fileName) !== null;
}

export function parseBase64DataUrl(
  dataUrl: string,
): { readonly mimeType: string; readonly base64: string } | null {
  const match = /^data:([^,]+),([a-z0-9+/=\r\n ]+)$/i.exec(dataUrl.trim());
  if (!match) return null;

  const headerParts: Array<string> = [];
  for (const part of (match[1] ?? "").split(";")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      headerParts.push(trimmed);
    }
  }
  if (headerParts.length < 2) {
    return null;
  }
  const trailingToken = headerParts.at(-1)?.toLowerCase();
  if (trailingToken !== "base64") {
    return null;
  }

  const mimeType = headerParts[0]?.toLowerCase();
  const base64 = match[2]?.replace(/\s+/g, "");
  if (!mimeType || !base64) return null;

  return { mimeType, base64 };
}

export function inferImageExtension(input: { mimeType: string; fileName?: string }): string {
  const key = input.mimeType.toLowerCase();
  const fromMime = Object.hasOwn(IMAGE_EXTENSION_BY_MIME_TYPE, key)
    ? IMAGE_EXTENSION_BY_MIME_TYPE[key]
    : undefined;
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
