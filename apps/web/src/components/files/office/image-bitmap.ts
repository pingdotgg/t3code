import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";

export async function officeImageBitmap(blob: Blob) {
  const bytes = new Uint8Array(await blob.slice(0, IMAGE_DIMENSIONS_HEADER_BYTES).arrayBuffer());
  let size = readImageDimensions(bytes);
  if (!size && bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const view = new DataView(bytes.buffer);
    size =
      view.getUint32(14, true) === 12
        ? { width: view.getUint16(18, true), height: view.getUint16(20, true) }
        : { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
  }
  // Unknown dimensions cannot be decoded safely: compressed bytes do not bound pixel memory.
  if (!size || size.width <= 0 || size.height <= 0 || size.width > 16_777_216 / size.height)
    throw new Error("This embedded image exceeds the preview pixel limit.");
  return createImageBitmap(blob);
}
