import { msg } from "gt-react";

import { m } from "~/i18n/messages";

/** Resolves web references without inheriting the desktop renderer's custom app scheme. */
export function resolveProtocolRelativeMediaUrl(src: string): string {
  if (!src.startsWith("//")) return src;
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "http:" ? "http:" : "https:";
  return `${protocol}${src}`;
}

function hexDigit(byte: number) {
  if (byte >= 48 && byte <= 57) return byte - 48;
  const lower = byte | 32;
  return lower >= 97 && lower <= 102 ? lower - 87 : -1;
}

// Compact escapes in place to keep large embedded resources out of JS number arrays.
function decodePercentBytes(payload: string) {
  const bytes = new TextEncoder().encode(payload);
  if (!payload.includes("%")) return bytes;
  let written = 0;
  for (let read = 0; read < bytes.length; read++) {
    const byte = bytes[read]!;
    if (byte === 37 && read + 2 < bytes.length) {
      const high = hexDigit(bytes[read + 1]!);
      const low = hexDigit(bytes[read + 2]!);
      if (high >= 0 && low >= 0) {
        bytes[written++] = high * 16 + low;
        read += 2;
        continue;
      }
    }
    bytes[written++] = byte;
  }
  return bytes.subarray(0, written);
}

function decodeBase64Bytes(payload: string) {
  const binary = atob(decodeURIComponent(payload));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes inline media locally; desktop connect-src omits `data:`, so fetch() cannot read it. */
export function readDataUrlBlob(src: string): Blob {
  // A fragment is never part of the payload; a literal `#` in data must be escaped as `%23`.
  const url = src.split("#", 1)[0] ?? src;
  const comma = url.indexOf(",");
  const [mimeType = "", ...parameters] = url.slice("data:".length, comma).split(";");
  const payload = url.slice(comma + 1);
  try {
    if (comma < 0) throw new Error(m(msg("Missing data URL payload.")));
    const isBase64 = parameters.some((parameter) => parameter.trim().toLowerCase() === "base64");
    // Base64 text is ASCII, so any escape that is not valid UTF-8 is malformed anyway.
    const bytes = isBase64 ? decodeBase64Bytes(payload) : decodePercentBytes(payload);
    return new Blob([bytes], { type: mimeType || "text/plain" });
  } catch (cause) {
    throw new Error(m(msg("This inline media could not be decoded.")), { cause });
  }
}

async function fetchMediaBlob(src: string): Promise<Blob> {
  const response = await fetch(src).catch(() => null);
  if (response?.ok) return response.blob();
  // An <img> can show media that fetch() may not read (CORS, CSP, cookies); desktop reads it natively.
  const desktop = typeof window === "undefined" ? undefined : window.desktopBridge;
  const native =
    desktop && /^https?:/i.test(src) ? await desktop.readMedia(src).catch(() => null) : null;
  if (native && native.status >= 200 && native.status < 300) {
    return new Blob([new Uint8Array(native.data)], { type: native.mimeType });
  }
  const status = native?.status ?? response?.status;
  if (status !== undefined)
    throw new Error(m(msg("The file could not be fetched (HTTP {status}).", { status })));
  throw new Error(
    desktop
      ? m(msg("The file could not be fetched. Check the connection and try again."))
      : m(
          msg(
            "The file could not be fetched. The host may block browser access (CORS), or the connection may be unavailable.",
          ),
        ),
  );
}

async function readMediaBlob(src: string): Promise<Blob> {
  if (/^data:/i.test(src)) return readDataUrlBlob(src);
  const blob = await fetchMediaBlob(src);
  if (blob.type.split(";", 1)[0] === "text/html") {
    throw new Error(
      m(msg("This link returned a web page instead of media. Open the original URL.")),
    );
  }
  return blob;
}

export async function downloadMedia(src: string, name: string): Promise<void> {
  const url = URL.createObjectURL(await readMediaBlob(src));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export async function readMediaPng(src: string): Promise<Blob> {
  const blob = await readMediaBlob(src);
  if (blob.type.split(";", 1)[0] === "image/png") return blob;

  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    try {
      await image.decode();
    } catch (cause) {
      throw new Error(
        m(msg("The browser could not decode this image for copying. Try saving it instead.")),
        {
          cause,
        },
      );
    }
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width <= 0 || height <= 0 || width * height > 64_000_000) {
      throw new Error(
        m(msg("This image is too large or has no usable dimensions. Try saving it instead.")),
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(m(msg("Image copying is unavailable in this browser.")));
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) =>
          png
            ? resolve(png)
            : reject(new Error(m(msg("The image could not be converted to PNG.")))),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
