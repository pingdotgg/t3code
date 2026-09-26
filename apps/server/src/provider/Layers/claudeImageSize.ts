import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

/**
 * Anthropic rejects every image over 2000px on a side once a request holds
 * more than 20 images. Claude Code scales the images in a turn's opening
 * message, but stores ones sent mid-turn as they are, so one oversized paste
 * breaks every later image read in the session.
 */
const CLAUDE_MAX_IMAGE_EDGE = 2000;

/**
 * Scales a PNG or JPEG down to fit CLAUDE_MAX_IMAGE_EDGE. Images already
 * within the limit come back untouched, so only oversized ones pay for a
 * decode.
 *
 * ponytail: decodes on the event loop, about 150ms for a phone screenshot,
 * 400ms for a Retina screenshot, and 0.7s for a 12MP photo. Only steered
 * images pay it. Move it to a worker if that stall shows up.
 */
export function fitClaudeImage(mimeType: string, bytes: Uint8Array): Uint8Array {
  const dimensions = readImageDimensions(bytes);
  if (!dimensions || Math.max(dimensions.width, dimensions.height) <= CLAUDE_MAX_IMAGE_EDGE) {
    return bytes;
  }
  if (mimeType === "image/png") {
    const image = PNG.sync.read(Buffer.from(bytes));
    const { width, height, data } = downscale(image);
    const scaled = new PNG({ width, height });
    scaled.data = Buffer.from(data.buffer);
    // Keep the source's channels; always writing RGBA can make a grayscale
    // or palette PNG several times larger than the original.
    const colorType = image.alpha ? (image.color ? 6 : 4) : image.color ? 2 : 0;
    return PNG.sync.write(scaled, { colorType });
  }
  if (mimeType === "image/jpeg") {
    const image = jpeg.decode(bytes, { useTArray: true });
    // The spread keeps the decoder's `exifBuffer`, so the EXIF orientation of
    // a phone photo survives the re-encode.
    return jpeg.encode({ ...image, ...downscale(image) }, 90).data;
  }
  // ponytail: GIF and WebP pass through; no pure-JS codec for them here. Add
  // one if oversized GIF or WebP attachments show up in practice.
  return bytes;
}

/** Box-filter downscale of RGBA pixels to fit CLAUDE_MAX_IMAGE_EDGE. */
function downscale(image: { width: number; height: number; data: Uint8Array }) {
  const scale = CLAUDE_MAX_IMAGE_EDGE / Math.max(image.width, image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const top = Math.floor((y * image.height) / height);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x++) {
      const left = Math.floor((x * image.width) / width);
      const right = Math.max(left + 1, Math.floor(((x + 1) * image.width) / width));
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sourceY = top; sourceY < bottom; sourceY++) {
        for (let sourceX = left; sourceX < right; sourceX++) {
          const offset = (sourceY * image.width + sourceX) * 4;
          red += image.data[offset] ?? 0;
          green += image.data[offset + 1] ?? 0;
          blue += image.data[offset + 2] ?? 0;
          alpha += image.data[offset + 3] ?? 0;
        }
      }
      const count = (bottom - top) * (right - left);
      const target = (y * width + x) * 4;
      data[target] = Math.round(red / count);
      data[target + 1] = Math.round(green / count);
      data[target + 2] = Math.round(blue / count);
      data[target + 3] = Math.round(alpha / count);
    }
  }
  return { width, height, data };
}
