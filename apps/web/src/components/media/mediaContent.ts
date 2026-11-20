import { decodeDataUrl } from "@t3tools/client-runtime/data-url";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";

/** Resolves web references without inheriting the desktop renderer's custom app scheme. */
export function resolveProtocolRelativeMediaUrl(src: string): string {
  if (!src.startsWith("//")) return src;
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "http:" ? "http:" : "https:";
  return `${protocol}${src}`;
}

/** Decodes inline media locally; desktop connect-src omits `data:`, so fetch() cannot read it. */
function readDataUrlBlob(src: string): Blob {
  try {
    return decodeDataUrl(src);
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
