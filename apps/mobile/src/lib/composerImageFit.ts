import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import {
  downscalableImageMimeType,
  fitImageAttachmentSize,
} from "@t3tools/client-runtime/image-attachment-size";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";
import { estimateBase64ByteSize } from "./base64";

const PHOTO_JPEG_QUALITY = 0.85;
const MAX_BYTE_LIMIT_SHRINKS = 3;

function shrinkToByteLimit(
  size: { readonly width: number; readonly height: number },
  bytes: number,
): { width: number; height: number } | null {
  if (bytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return null;
  // Encoded size tracks pixel count, so scale each edge by the square root with some headroom.
  const scale = Math.sqrt(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / bytes) * 0.9;
  const next = {
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
  };
  return next.width < size.width || next.height < size.height ? next : null;
}

export async function renderPhoto(
  uri: string,
  format: "jpeg" | "png" = "jpeg",
): Promise<{ base64: string; uri: string }> {
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  let image = await ImageManipulator.manipulate(uri).renderAsync();
  try {
    let size = fitImageAttachmentSize(image);
    for (let shrinks = 0; ; shrinks += 1) {
      if (size !== null) {
        const resized = await ImageManipulator.manipulate(image).resize(size).renderAsync();
        image.release();
        image = resized;
      }
      const saved = await image.saveAsync({
        format: format === "png" ? SaveFormat.PNG : SaveFormat.JPEG,
        compress: PHOTO_JPEG_QUALITY,
        base64: true,
      });
      if (!saved.base64) {
        throw new Error("The rendered photo has no bytes.");
      }
      // PNG ignores compress, so a resampled PNG can encode larger than its original.
      size =
        shrinks < MAX_BYTE_LIMIT_SHRINKS
          ? shrinkToByteLimit(image, estimateBase64ByteSize(saved.base64))
          : null;
      if (size === null) return { base64: saved.base64, uri: saved.uri };
      try {
        const { File } = await import("expo-file-system");
        const discarded = new File(saved.uri);
        if (discarded.exists) discarded.delete();
      } catch (error) {
        console.warn("[composer-images] could not remove discarded render", error);
      }
    }
  } finally {
    image.release();
  }
}

/** Returns null to keep original bytes if they fit, use another format, or native rendering fails. */
export async function fitComposerImage(image: {
  readonly uri: string;
  readonly mimeType: string;
  readonly base64: string;
}): Promise<{ base64: string; uri: string } | null> {
  const mimeType = downscalableImageMimeType(image.mimeType);
  if (mimeType === null) return null;
  try {
    const header = atob(image.base64.slice(0, Math.ceil(IMAGE_DIMENSIONS_HEADER_BYTES / 3) * 4));
    const bytes = new Uint8Array(header.length);
    for (let index = 0; index < header.length; index += 1) bytes[index] = header.charCodeAt(index);
    const dimensions = readImageDimensions(bytes);
    if (dimensions === null || fitImageAttachmentSize(dimensions) === null) return null;
    return await renderPhoto(image.uri, mimeType === "image/png" ? "png" : "jpeg");
  } catch (error) {
    console.warn("[composer-images] could not scale an oversized image", error);
    return null;
  }
}
