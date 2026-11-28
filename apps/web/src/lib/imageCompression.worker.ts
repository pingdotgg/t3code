import {
  encodeCanvasOnThisThread,
  fitImageForAttachment,
  type ImageSize,
  renderThumbnail,
} from "./imageCanvas";

export type ImageWorkerTask =
  | {
      kind: "encode";
      bitmap: ImageBitmap;
      colorSpace: PredefinedColorSpace;
      mimeType: string;
      quality: number;
    }
  | { kind: "fit"; file: Blob; mimeType: string; quality: number }
  | { kind: "thumbnail"; file: Blob };

export interface ImageWorkerResults {
  encode: Blob | null;
  fit: { blob: Blob; imageSize: ImageSize } | null;
  thumbnail: string | null;
}

export type ImageWorkerResponse =
  | { id: number; value: ImageWorkerResults[ImageWorkerTask["kind"]] }
  | { id: number; failed: true };

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as string));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

async function encodeBitmap(task: Extract<ImageWorkerTask, { kind: "encode" }>) {
  const { bitmap, colorSpace, mimeType, quality } = task;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { colorSpace });
    if (!context) throw new Error("2D canvas unavailable");
    context.drawImage(bitmap, 0, 0);
    return await encodeCanvasOnThisThread(canvas, colorSpace, quality, mimeType);
  } finally {
    bitmap.close();
  }
}

async function run(task: ImageWorkerTask): Promise<ImageWorkerResults[ImageWorkerTask["kind"]]> {
  // Without a canvas here the shared helpers report "nothing to do"; the page must draw instead.
  if (typeof OffscreenCanvas !== "function") throw new Error("OffscreenCanvas unavailable");
  switch (task.kind) {
    case "encode":
      return encodeBitmap(task);
    case "fit":
      return fitImageForAttachment(
        task.file,
        task.mimeType,
        task.quality,
        encodeCanvasOnThisThread,
      );
    case "thumbnail": {
      const blob = await renderThumbnail(task.file, encodeCanvasOnThisThread);
      return blob ? readAsDataUrl(blob) : null;
    }
  }
}

self.addEventListener("message", (event: MessageEvent<{ id: number; task: ImageWorkerTask }>) => {
  const { id, task } = event.data;
  void run(task).then(
    (value) => self.postMessage({ id, value } satisfies ImageWorkerResponse, { transfer: [] }),
    () => self.postMessage({ id, failed: true } satisfies ImageWorkerResponse, { transfer: [] }),
  );
});
