const MAX_PIXELS = 32_000_000;

function validateTiffMetadata(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  if (bytes.byteLength < 8) throw new Error("Invalid TIFF metadata.");
  const order = view.getUint16(0);
  const littleEndian = order === 0x4949;
  if (![0x4949, 0x4d4d].includes(order) || view.getUint16(2, littleEndian) !== 42)
    throw new Error("Invalid TIFF metadata.");
  const visited = new Set<number>();
  let entries = 0;
  let allocation = 0;
  const inspect = (offset: number, depth: number) => {
    if (depth > 8 || visited.has(offset) || offset < 8 || offset + 2 > bytes.byteLength)
      throw new Error("Invalid TIFF metadata.");
    visited.add(offset);
    const count = view.getUint16(offset, littleEndian);
    entries += count;
    if (entries > 2048 || offset + 2 + count * 12 + 4 > bytes.byteLength)
      throw new Error("This TIFF has too much or truncated metadata.");
    for (let index = 0; index < count; index++) {
      const entry = offset + 2 + index * 12;
      const tag = view.getUint16(entry, littleEndian);
      const type = view.getUint16(entry + 2, littleEndian);
      const values = view.getUint32(entry + 4, littleEndian);
      const width = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type];
      if (!width) throw new Error("Unsupported TIFF metadata type.");
      const length = values * width;
      const start = length > 4 ? view.getUint32(entry + 8, littleEndian) : entry + 8;
      // The decoder retains a separate array or string for every tag, including aliases.
      allocation += values * Math.max(16, width);
      if (start + length > bytes.byteLength || allocation > 8 * 1024 * 1024)
        throw new Error("This TIFF has too much or truncated metadata.");
      if (tag === 0x8769 || tag === 0x8825) {
        if (type !== 4 || values !== 1) throw new Error("Invalid TIFF metadata pointer.");
        inspect(view.getUint32(entry + 8, littleEndian), depth + 1);
      }
    }
  };
  inspect(view.getUint32(4, littleEndian), 0);
}

function dimensions(width: number, height: number) {
  if (!(width > 0 && height > 0) || width > 16384 || height > 16384 || width > MAX_PIXELS / height)
    throw new Error("Image previews are limited to 32 megapixels and 16,384 pixels per side.");
}

function validateHeif(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  let found = false;
  let count = 0;
  const boxes = (start: number, end: number, depth: number) => {
    if (depth > 4) return;
    let offset = start;
    while (offset + 8 <= end) {
      if (++count > 2048) throw new Error("This image has too much metadata.");
      let size = view.getUint32(offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) throw new Error("Invalid HEIF metadata.");
        const large = view.getBigUint64(offset + 8);
        if (large > BigInt(bytes.byteLength)) throw new Error("Invalid HEIF metadata.");
        size = Number(large);
        header = 16;
      } else if (size === 0) size = end - offset;
      if (size < header || offset + size > end) throw new Error("Invalid HEIF metadata.");
      const type = view.getUint32(offset + 4);
      if (type === 0x69737065) {
        if (size < header + 12) throw new Error("Invalid HEIF dimensions.");
        dimensions(view.getUint32(offset + header + 4), view.getUint32(offset + header + 8));
        found = true;
      } else if (type === 0x6d657461 || type === 0x69707270 || type === 0x6970636f)
        boxes(offset + header + (type === 0x6d657461 ? 4 : 0), offset + size, depth + 1);
      offset += size;
    }
  };
  boxes(0, bytes.byteLength, 0);
  if (!found) throw new Error("This HEIF image has no readable dimensions.");
}

// Count LZW output without building strings before the decoder allocates its strip buffer.
function validateLzw(bytes: Uint8Array, limit: number) {
  const lengths = new Uint16Array(4096).fill(1, 0, 256);
  let bits = 9;
  let bit = 0;
  let next = 258;
  let previous = 0;
  let total = 0;
  while (bit + bits <= bytes.length * 8) {
    let code = 0;
    for (let index = 0; index < bits; index++, bit++)
      code = (code << 1) | ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
    if (code === 257) return;
    if (code === 256) {
      bits = 9;
      next = 258;
      previous = 0;
      continue;
    }
    const length = code < next ? lengths[code]! : code === next && previous ? previous + 1 : 0;
    if (!length || (total += length) > limit) throw new Error("Invalid or oversized TIFF strip.");
    if (previous) {
      if (next >= 4096) throw new Error("Invalid TIFF LZW dictionary.");
      lengths[next++] = previous + 1;
      if (next === (1 << bits) - 1 && bits < 12) bits++;
    }
    previous = length;
  }
  throw new Error("Truncated TIFF strip.");
}

async function validateTiffStrips(bytes: ArrayBuffer, image: import("tiff").TiffIfd) {
  const offsets = image.tiled ? image.tileOffsets : image.stripOffsets;
  const counts = image.tiled ? image.tileByteCounts : image.stripByteCounts;
  const width = image.tiled ? image.tileWidth! : image.width;
  const height = image.tiled ? image.tileHeight! : Math.min(image.rowsPerStrip, image.height);
  dimensions(width, height);
  const limit = width * height * image.components * (image.bitsPerSample / 8);
  if (!offsets?.length || offsets.length > 2048 || counts?.length !== offsets.length)
    throw new Error("Unsupported TIFF strip layout.");
  let expanded = 0;
  for (let index = 0; index < offsets.length; index++) {
    const offset = offsets[index]!;
    const size = counts[index]!;
    if (offset < 0 || size < 1 || offset + size > bytes.byteLength)
      throw new Error("Invalid TIFF strip.");
    const strip = new Uint8Array(bytes, offset, size);
    if (image.compression === 5) validateLzw(strip, limit);
    else if (image.compression === 8 || image.compression === 32946) {
      const reader = new Blob([strip])
        .stream()
        .pipeThrough(new DecompressionStream("deflate"))
        .getReader();
      let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if ((length += value.length) > limit) throw new Error("Oversized TIFF strip.");
        }
      } finally {
        await reader.cancel();
      }
    } else if (image.compression !== 1) throw new Error("This TIFF compression is not supported.");
    // Bound repeated strips and padding as well as the visible image dimensions.
    expanded += limit;
    if (expanded > 256 * 1024 * 1024) throw new Error("This TIFF has too much image data.");
  }
}

async function decode(bytes: ArrayBuffer, heif: boolean) {
  if (bytes.byteLength > 50 * 1024 * 1024) throw new Error("Preview limited to files under 50 MB.");
  if (heif) {
    validateHeif(bytes);
    const { heicTo } = await import("heic-to/next");
    return await heicTo({ blob: new Blob([bytes]), type: "image/png" });
  }
  const { decode: decodeTiff } = await import("tiff");
  validateTiffMetadata(bytes);
  const metadata = decodeTiff(bytes, { ignoreImageData: true, pages: [0] })[0];
  if (!metadata) throw new Error("This TIFF has no readable image.");
  dimensions(metadata.width, metadata.height);
  if (metadata.orientation && metadata.orientation !== 1)
    throw new Error("This TIFF orientation is not supported.");
  if (
    (metadata.tiled && metadata.components > 1) ||
    ![1, 2, 3, 4].includes(metadata.components) ||
    ![8, 16].includes(metadata.bitsPerSample) ||
    ![0, 1, 2, 3].includes(metadata.type)
  )
    throw new Error("This TIFF color format is not supported.");
  await validateTiffStrips(bytes, metadata);
  const image = decodeTiff(bytes, { pages: [0] })[0]!;
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  const scale = image.bitsPerSample === 16 ? 257 : 1;
  const palette = image.palette;
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    const index = pixel * image.components;
    if (palette) {
      const color = palette[image.data[index]!] ?? [0, 0, 0];
      for (let channel = 0; channel < 3; channel++)
        rgba[pixel * 4 + channel] = color[channel]! / 257;
    } else if (image.type === 2) {
      for (let channel = 0; channel < 3; channel++)
        rgba[pixel * 4 + channel] = image.data[index + channel]! / scale;
    } else {
      const gray = image.data[index]! / scale;
      rgba.fill(gray, pixel * 4, pixel * 4 + 3);
    }
    rgba[pixel * 4 + 3] = image.alpha ? image.data[index + image.components - 1]! / scale : 255;
  }
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image decoding is unavailable.");
  context.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
  return await canvas.convertToBlob({ type: "image/png" });
}

self.addEventListener("message", (event: MessageEvent<{ bytes: ArrayBuffer; heif: boolean }>) => {
  void decode(event.data.bytes, event.data.heif).then(
    (blob) => self.postMessage({ blob }, { transfer: [] }),
    (cause: unknown) =>
      self.postMessage(
        { error: cause instanceof Error ? cause.message : "Could not decode this image." },
        { transfer: [] },
      ),
  );
});
