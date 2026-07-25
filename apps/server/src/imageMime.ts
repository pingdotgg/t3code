import Mime from "@effect/platform-node/Mime";

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

// Whether `code` is a character the base64 payload may contain, aside from
// the whitespace handled separately below.
function isBase64Char(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2b || // +
    code === 0x2f || // /
    code === 0x3d // =
  );
}

function isBase64Whitespace(code: number): boolean {
  return code === 0x0d || code === 0x0a || code === 0x20; // \r \n space
}

// Data URLs carry the full image payload, so this parser must never run a
// regex across the payload: V8's regex engine borrows the JS call stack, and
// matching a multi-megabyte string from a deep call stack (e.g. inside fiber
// execution) throws "Maximum call stack size exceeded".
export function parseBase64DataUrl(
  dataUrl: string,
): { readonly mimeType: string; readonly base64: string } | null {
  const trimmed = dataUrl.trim();
  if (trimmed.slice(0, 5).toLowerCase() !== "data:") return null;

  const commaIndex = trimmed.indexOf(",");
  if (commaIndex === -1) return null;
  const header = trimmed.slice(5, commaIndex);
  if (header.length === 0) return null;

  const headerParts: Array<string> = [];
  for (const part of header.split(";")) {
    const partTrimmed = part.trim();
    if (partTrimmed.length > 0) {
      headerParts.push(partTrimmed);
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
  if (!mimeType) return null;

  const payload = trimmed.slice(commaIndex + 1);
  const runs: Array<string> = [];
  let runStart = -1;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (isBase64Char(code)) {
      if (runStart === -1) runStart = index;
      continue;
    }
    if (!isBase64Whitespace(code)) return null;
    if (runStart !== -1) {
      runs.push(payload.slice(runStart, index));
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    runs.push(payload.slice(runStart));
  }
  const base64 = runs.length === 1 ? runs[0]! : runs.join("");
  if (base64.length === 0 || base64.length % 4 !== 0) return null;
  const firstPad = base64.indexOf("=");
  if (firstPad !== -1) {
    // '=' is only valid as one or two trailing padding characters; Node's
    // decoder would otherwise silently truncate at the first '='.
    if (base64.length - firstPad > 2) return null;
    for (let index = firstPad; index < base64.length; index += 1) {
      if (base64.charCodeAt(index) !== 0x3d) return null;
    }
  }

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
