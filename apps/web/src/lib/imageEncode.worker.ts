export interface ImageEncodeRequest {
  id: number;
  bitmap: ImageBitmap;
  colorSpace: PredefinedColorSpace;
  mimeType: string;
  quality: number;
}

export type ImageEncodeResponse = { id: number; blob: Blob } | { id: number; failed: true };

async function encode({ bitmap, colorSpace, mimeType, quality }: ImageEncodeRequest) {
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { colorSpace });
    if (!context) throw new Error("2D canvas unavailable");
    context.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: mimeType, quality });
  } finally {
    bitmap.close();
  }
}

self.addEventListener("message", (event: MessageEvent<ImageEncodeRequest>) => {
  const { id } = event.data;
  void encode(event.data).then(
    (blob) => self.postMessage({ id, blob } satisfies ImageEncodeResponse, { transfer: [] }),
    () => self.postMessage({ id, failed: true } satisfies ImageEncodeResponse, { transfer: [] }),
  );
});
