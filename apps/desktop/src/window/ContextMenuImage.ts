import * as Electron from "electron";
import { sourceDimensions } from "../preview/FaviconCapture.ts";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isPng = (bytes: Buffer) => bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

function hasSafeDimensions(bytes: Buffer): boolean {
  const dimensions = sourceDimensions(bytes, MAX_IMAGE_BYTES / 4);
  return (
    dimensions !== null &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width * dimensions.height <= MAX_IMAGE_BYTES / 4
  );
}

const osClipboardFormat = (name: string) => `electron application/osclipboard;format="${name}"`;

// Chromium's CF_DIBV5 layout: a bottom-up BITMAPV5HEADER image of the decoded BGRA pixels.
function dibV5(image: Electron.NativeImage): Buffer {
  const { width, height } = image.getSize();
  const pixels = image.toBitmap();
  const rowBytes = width * 4;
  const dib = Buffer.alloc(124 + pixels.byteLength);
  dib.writeUInt32LE(124, 0);
  dib.writeInt32LE(width, 4);
  dib.writeInt32LE(height, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0xff000000, 52);
  dib.writeUInt32LE(0x57696e20, 56);
  dib.writeUInt32LE(4, 108);
  for (let row = 0; row < height; row += 1) {
    pixels.copy(dib, 124 + (height - 1 - row) * rowBytes, row * rowBytes, (row + 1) * rowBytes);
  }
  return dib;
}

// An "image/png" entry is decoded and re-encoded by Electron, which drops PNG text chunks.
// Raw OS formats keep the bytes. Windows also needs a DIB, or Chromium will not paste the
// image: "#17" resolves to CF_DIBV5, and the bare "PNG" key sorts first, as Chromium writes it.
function sourcePngClipboardItem(
  png: Buffer,
  image: Electron.NativeImage,
  platform: NodeJS.Platform,
): Electron.ClipboardItem {
  const blob = new Blob([Uint8Array.from(png)], { type: "image/png" });
  if (platform === "win32") {
    return new Electron.ClipboardItem({
      PNG: blob,
      [osClipboardFormat("#17")]: new Blob([Uint8Array.from(dibV5(image))]),
    });
  }
  return new Electron.ClipboardItem({
    [osClipboardFormat(platform === "darwin" ? "public.png" : "image/png")]: blob,
  });
}

/** Copies a PNG with its bytes unchanged; false when it is not a PNG this process can decode. */
export async function copySourcePng(bytes: Buffer, platform: NodeJS.Platform): Promise<boolean> {
  if (!isPng(bytes) || bytes.byteLength > MAX_IMAGE_BYTES || !hasSafeDimensions(bytes)) {
    return false;
  }
  const image = Electron.nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return false;
  await Electron.clipboard.write([sourcePngClipboardItem(bytes, image, platform)]);
  return true;
}

async function readSourceImage(srcURL: string): Promise<Buffer> {
  const url = new URL(srcURL);
  if (
    !["https:", "http:", "data:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.protocol === "data:" && srcURL.length > MAX_IMAGE_BYTES * 3)
  ) {
    throw new Error("Unsupported image URL");
  }
  const fetchImage = url.protocol === "data:" ? globalThis.fetch : Electron.net.fetch;
  const response = await fetchImage(url.href, {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error("Image request failed or exceeded the size limit");
  }
  if (!response.body) throw new Error("Image response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Image exceeded the size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, byteLength);
}

export async function copyContextMenuImage(
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
  platform: NodeJS.Platform,
): Promise<void> {
  const frame = params.frame;
  if (contents.isDestroyed() || !frame || frame.isDestroyed()) return;
  if (frame === contents.mainFrame) {
    // copyImageAt copies the decoded bitmap, so it is only for sources that are not a readable PNG.
    const copied = await readSourceImage(params.srcURL).then(
      (bytes) => copySourcePng(bytes, platform),
      () => false,
    );
    if (!copied && !contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
    return;
  }

  const bytes = await readSourceImage(params.srcURL);
  if (!hasSafeDimensions(bytes)) throw new Error("Image dimensions exceed the size limit");
  if (contents.isDestroyed() || frame.isDestroyed()) return;
  const image = Electron.nativeImage.createFromBuffer(bytes);
  let png: Buffer | undefined;
  if (image.isEmpty()) {
    const decoded: unknown = await contents.executeJavaScriptInIsolatedWorld(1002, [
      {
        code: `(async () => {
          const source = Uint8Array.from(atob("${bytes.toString("base64")}"), char => char.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([source]));
          try {
            if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.width * bitmap.height > ${MAX_IMAGE_BYTES / 4}) {
              throw new Error("Image dimensions exceed the size limit");
            }
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Image could not be decoded");
            context.drawImage(bitmap, 0, 0);
            const output = await canvas.convertToBlob({ type: "image/png" });
            if (output.size > ${MAX_IMAGE_BYTES}) throw new Error("PNG exceeded the size limit");
            return await output.arrayBuffer();
          } finally {
            bitmap.close();
          }
        })()`,
      },
    ]);
    if (!(decoded instanceof ArrayBuffer)) throw new Error("Image could not be decoded");
    png = Buffer.from(decoded);
  } else if (!isPng(bytes)) {
    png = image.toPNG();
  }
  if (png && png.byteLength > MAX_IMAGE_BYTES) throw new Error("PNG exceeded the size limit");
  if (contents.isDestroyed() || frame.isDestroyed()) return;
  await Electron.clipboard.write([
    png
      ? new Electron.ClipboardItem({
          "image/png": new Blob([Uint8Array.from(png)], { type: "image/png" }),
        })
      : sourcePngClipboardItem(bytes, image, platform),
  ]);
}
