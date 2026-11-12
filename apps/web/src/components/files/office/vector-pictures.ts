// SVG pictures, which only an image element decodes. Workers have none, so the window rasterizes them for the worker.

/** The longest side a decoded picture keeps: enough for a full-width page or slide on a high-density screen. */
export const maxImageSide = 2560;

/** An SVG picture the worker cannot decode, which the window rasterizes at `size`, or at its own size when absent. */
export type VectorRequest = {
  readonly asset: string;
  readonly blob: Blob;
  readonly size: { readonly width: number; readonly height: number } | undefined;
};

/** A rasterized SVG picture, or none when the window could not decode it either. */
export type VectorBitmap = { readonly asset: string; readonly bitmap: ImageBitmap | undefined };

/** Rasterizes a worker's SVG picture in the window. */
export async function rasterize(request: VectorRequest): Promise<VectorBitmap> {
  const url = URL.createObjectURL(request.blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    const shrink = Math.min(1, maxImageSide / Math.max(image.naturalWidth, image.naturalHeight));
    const size = request.size ?? {
      width: Math.max(1, Math.round(image.naturalWidth * shrink)),
      height: Math.max(1, Math.round(image.naturalHeight * shrink)),
    };
    return {
      asset: request.asset,
      bitmap: await createImageBitmap(image, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: "high",
      }),
    };
  } catch {
    return { asset: request.asset, bitmap: undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}
