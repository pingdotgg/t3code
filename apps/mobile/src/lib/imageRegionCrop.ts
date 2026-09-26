import { imageRegionPixels, type ImageRegion } from "@t3tools/client-runtime/image-region-citation";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";

import { estimateBase64ByteSize } from "./base64";
import type { DraftComposerImageAttachment } from "./composerImages";
import { uuidv4 } from "./uuid";

/** Matches the web crop limit: providers downscale larger images before the model sees them. */
const MAX_CROP_EDGE_PX = 2048;

/**
 * Crops a cited region from a local or data URI into a draft image attachment. The native
 * image manipulator cannot draw, so the crop is exactly the marked pixels rather than the web
 * client's padded crop with an outline.
 */
export async function cropImageRegionAttachment(input: {
  readonly uri: string;
  readonly region: ImageRegion;
  readonly name: string;
}): Promise<DraftComposerImageAttachment> {
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  const source = await ImageManipulator.manipulate(input.uri).renderAsync();
  const crop = await (async () => {
    try {
      const rect = imageRegionPixels(input.region, { width: source.width, height: source.height });
      let context = ImageManipulator.manipulate(source).crop({
        originX: rect.x,
        originY: rect.y,
        width: rect.width,
        height: rect.height,
      });
      if (Math.max(rect.width, rect.height) > MAX_CROP_EDGE_PX) {
        context = context.resize(
          rect.width >= rect.height ? { width: MAX_CROP_EDGE_PX } : { height: MAX_CROP_EDGE_PX },
        );
      }
      return await context.renderAsync();
    } finally {
      source.release();
    }
  })();
  try {
    const saved = await crop.saveAsync({ format: SaveFormat.PNG, base64: true });
    if (!saved.base64) throw new Error("The cropped region has no bytes.");
    const sizeBytes = estimateBase64ByteSize(saved.base64);
    if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      throw new Error("The region is too large to attach. Select a smaller region.");
    }
    return {
      id: uuidv4(),
      type: "image",
      name: input.name,
      mimeType: "image/png",
      sizeBytes,
      dataUrl: `data:image/png;base64,${saved.base64}`,
      previewUri: saved.uri,
    };
  } finally {
    crop.release();
  }
}
