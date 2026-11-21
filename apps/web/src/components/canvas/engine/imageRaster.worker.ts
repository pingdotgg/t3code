export interface ImageRasterRequest {
  readonly id: number;
  readonly bitmap: ImageBitmap | null;
  readonly svg: Blob | null;
  readonly width: number;
  readonly height: number;
}

export type ImageRasterResponse =
  | { readonly id: number; readonly bitmap: ImageBitmap }
  | { readonly id: number; readonly error: string };

// High-quality downsampling can take tens of milliseconds even though the
// final atlas tile is small. Keep that work off the render thread.
self.addEventListener("message", async (event: MessageEvent<ImageRasterRequest>) => {
  const { id, svg, width, height } = event.data;
  let bitmap = event.data.bitmap;
  try {
    if (svg) bitmap = await createImageBitmap(svg, { resizeWidth: width, resizeHeight: height });
    if (!bitmap) throw new Error("Image source is unavailable");
    const canvas = new OffscreenCanvas(width + 2, height + 2);
    // The atlas upload reads CPU pixels; avoid a GPU readback on the render thread.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 1, 1, width, height);
    // Extend the outermost texels exactly, including corners, to prevent
    // transparent seams when the atlas is sampled between adjacent texels.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 1, 1, width, 1, 1, 0, width, 1);
    ctx.drawImage(canvas, 1, height, width, 1, 1, height + 1, width, 1);
    ctx.drawImage(canvas, 1, 0, 1, height + 2, 0, 0, 1, height + 2);
    ctx.drawImage(canvas, width, 0, 1, height + 2, width + 1, 0, 1, height + 2);
    const raster = canvas.transferToImageBitmap();
    self.postMessage({ id, bitmap: raster } satisfies ImageRasterResponse, { transfer: [raster] });
  } catch (error) {
    self.postMessage(
      {
        id,
        // oxlint-disable-next-line t3code/no-untranslated-copy -- worker error detail, reported raw like a thrown error message
        error: error instanceof Error ? error.message : "Image raster failed",
      } satisfies ImageRasterResponse,
      { transfer: [] },
    );
  } finally {
    // The request is a structured clone. The render thread retains its source.
    bitmap?.close();
  }
});
