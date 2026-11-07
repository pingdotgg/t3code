/// <reference lib="webworker" />
import type { ChatBackgroundEffect } from "@t3tools/contracts";

import { applyChatBackgroundEffect } from "./chatBackgroundEffects";

export interface ChatBackgroundWorkerRequest {
  readonly image: Blob;
  readonly effect: Exclude<ChatBackgroundEffect, "none">;
  readonly light: boolean;
}

const MAX_EDGE = 2048;

self.addEventListener("message", (event: MessageEvent<ChatBackgroundWorkerRequest>) => {
  void render(event.data).then(
    (result) => self.postMessage({ result }),
    (error: unknown) => self.postMessage({ error: String(error) }),
  );
});

async function render({ image, effect, light }: ChatBackgroundWorkerRequest) {
  const bitmap = await createImageBitmap(image);
  const scale = Math.min(1, MAX_EDGE / bitmap.width, MAX_EDGE / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const pixels = context.getImageData(0, 0, width, height).data;
  const output = applyChatBackgroundEffect({ width, height, pixels }, effect, light);
  context.putImageData(new ImageData(new Uint8ClampedArray(output), width, height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}
