const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Returns the first complete PNG in `bytes`, or undefined. `adb exec-out screencap -p` can print
 * warnings, such as a foldable's multiple displays, around the image.
 */
export const extractPng = <Buffer extends ArrayBufferLike>(
  bytes: Uint8Array<Buffer>,
): Uint8Array<Buffer> | undefined => {
  const start = bytes.findIndex((_, index) =>
    PNG_SIGNATURE.every((value, offset) => bytes[index + offset] === value),
  );
  if (start < 0) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let chunk = start + PNG_SIGNATURE.length; chunk + 12 <= bytes.length;) {
    const end = chunk + 12 + view.getUint32(chunk);
    if (end > bytes.length) return undefined;
    if (String.fromCharCode(...bytes.subarray(chunk + 4, chunk + 8)) === "IEND") {
      return bytes.subarray(start, end);
    }
    chunk = end;
  }
  return undefined;
};
