import { m } from "~/i18n/messages";
import { msg } from "gt-react";
import { imageEditorSvgMarkup, type ImageEditorDocument } from "./imageEditorDocument";
import { readMediaBlob } from "../media/mediaContent";

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(m(msg("This image could not be decoded for editing."))));
    image.src = src;
  });
}

export async function loadEditorImage(src: string): Promise<HTMLImageElement> {
  const blob = await readMediaBlob(src);
  const objectUrl = URL.createObjectURL(blob);
  const result = await decodeImage(objectUrl).then(
    (image) => ({ image, error: null }),
    (error: unknown) => ({ image: null, error }),
  );
  URL.revokeObjectURL(objectUrl);
  if (!result.image) throw result.error;
  return result.image;
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error(m(msg("The edited image could not be exported."))));
    }, "image/png");
  });
}

export async function exportEditorImage(
  image: HTMLImageElement,
  document: ImageEditorDocument,
  name: string,
  options: { mode: "annotated" | "mask" | "original" } = { mode: "annotated" },
): Promise<File> {
  const frame = document.crop ?? { x: 0, y: 0, width: document.width, height: document.height };
  const width = Math.max(1, Math.round(frame.width));
  const height = Math.max(1, Math.round(frame.height));
  if (width > 16384 || height > 16384 || width * height > 32_000_000) {
    throw new Error(
      m(msg("This image is too large to export. Crop it to fewer than 32 million pixels first.")),
    );
  }
  const canvas = globalThis.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(m(msg("Your browser could not create an image editing canvas.")));
  if (options.mode === "mask") {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, width, height);
  } else {
    context.drawImage(image, frame.x, frame.y, frame.width, frame.height, 0, 0, width, height);
  }
  if (options.mode !== "original") {
    const markup = imageEditorSvgMarkup(document, { mode: options.mode });
    if (markup) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${frame.x} ${frame.y} ${frame.width} ${frame.height}">${markup}</svg>`;
      const objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const decoded = await decodeImage(objectUrl).then(
        (overlay) => ({ overlay, error: null }),
        (error: unknown) => ({ overlay: null, error }),
      );
      URL.revokeObjectURL(objectUrl);
      if (!decoded.overlay) throw decoded.error;
      context.drawImage(decoded.overlay, 0, 0, width, height);
      decoded.overlay.src = "";
    }
  }
  const blob = await pngBlob(canvas);
  canvas.width = 0;
  canvas.height = 0;
  const baseName = name.replace(/\.[^./\\]+$/, "").replace(/[/\\]/g, "-") || "image";
  const suffix =
    options.mode === "original" ? "original" : options.mode === "mask" ? "mask" : "guidance";
  return new File([blob], `${baseName}-${suffix}.png`, { type: "image/png" });
}
