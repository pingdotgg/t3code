// @effect-diagnostics nodeBuiltinImport:off - Thumbnails stream through node:zlib, which
// Effect does not wrap, from a descriptor the caller has already validated.
import type * as NodeFSP from "node:fs/promises";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import { encodeRgbaPng, isUniformRgba } from "./rgbaPng.ts";

export interface BlendThumbnailLimits {
  /** Source bytes read, compressed or not. */
  readonly maxInputBytes: number;
  /** Decompressed bytes scanned for the thumbnail block. */
  readonly maxScanBytes: number;
  /** Largest accepted width or height. */
  readonly maxDimension: number;
}

export const BLEND_THUMBNAIL_LIMITS: BlendThumbnailLimits = {
  maxInputBytes: 16 * 1024 * 1024,
  maxScanBytes: 32 * 1024 * 1024,
  maxDimension: 1024,
};

export type BlendThumbnailScan =
  | {
      readonly status: "found";
      readonly width: number;
      readonly height: number;
      /** Top-down RGBA rows. */
      readonly rgba: Uint8Array;
    }
  | { readonly status: "absent" }
  | { readonly status: "incomplete" };

type BlockHeaderLayout = "bhead4" | "small-bhead8" | "large-bhead8";

const BLOCK_HEADER_BYTES: Record<BlockHeaderLayout, number> = {
  bhead4: 20,
  "small-bhead8": 24,
  "large-bhead8": 32,
};

const ABSENT = { status: "absent" } as const;
const INCOMPLETE = { status: "incomplete" } as const;
const ASCII_ZERO = 0x30;
const FIRST_VERSION_WITH_THUMBNAILS = 250;

const isDigit = (byte: number | undefined) =>
  byte !== undefined && byte >= ASCII_ZERO && byte <= ASCII_ZERO + 9;

const digits = (bytes: Uint8Array, start: number, count: number) => {
  let value = 0;
  for (let index = start; index < start + count; index += 1) {
    const byte = bytes[index];
    if (!isDigit(byte)) return null;
    value = value * 10 + (byte! - ASCII_ZERO);
  }
  return value;
};

const ascii = (bytes: Uint8Array, start: number, count: number) =>
  String.fromCharCode(...bytes.subarray(start, start + count));

function readFileHeader(
  bytes: Uint8Array,
): { readonly size: number; readonly layout: BlockHeaderLayout } | "absent" | "incomplete" {
  if (bytes.length < 12) return "incomplete";
  if (ascii(bytes, 0, 7) !== "BLENDER") return "absent";
  const pointer = bytes[7];
  // Legacy header: `BLENDER`, pointer size (`_` 4 bytes, `-` 8 bytes), endianness, version.
  if (pointer === 0x5f || pointer === 0x2d) {
    // Big-endian files are only written by builds Blender no longer supports.
    if (bytes[8] !== 0x76) return "absent";
    const version = digits(bytes, 9, 3);
    if (version === null || version < FIRST_VERSION_WITH_THUMBNAILS) return "absent";
    return { size: 12, layout: pointer === 0x5f ? "bhead4" : "small-bhead8" };
  }
  // Blender 5.0+: `BLENDER`, header size, `-`, file format version, endianness, version.
  if (digits(bytes, 7, 2) !== 17) return "absent";
  if (bytes.length < 17) return "incomplete";
  if (bytes[9] !== 0x2d || digits(bytes, 10, 2) !== 1 || bytes[12] !== 0x76) return "absent";
  if (digits(bytes, 13, 4) === null) return "absent";
  return { size: 17, layout: "large-bhead8" };
}

/** Scans decompressed `.blend` bytes; `incomplete` asks for more of the file. */
export function scanBlendThumbnail(
  bytes: Uint8Array,
  maxDimension = BLEND_THUMBNAIL_LIMITS.maxDimension,
): BlendThumbnailScan {
  const header = readFileHeader(bytes);
  if (header === "absent") return ABSENT;
  if (header === "incomplete") return INCOMPLETE;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockHeaderBytes = BLOCK_HEADER_BYTES[header.layout];
  let offset = header.size;
  while (true) {
    if (offset + blockHeaderBytes > bytes.length) return INCOMPLETE;
    const code = ascii(bytes, offset, 4);
    const length =
      header.layout === "large-bhead8"
        ? Number(view.getBigInt64(offset + 16, true))
        : view.getInt32(offset + 4, true);
    if (length < 0 || !Number.isSafeInteger(length)) return ABSENT;
    const dataStart = offset + blockHeaderBytes;
    // Blender writes optional render info, then the thumbnail, before any scene data.
    if (code === "REND") {
      offset = dataStart + length;
      continue;
    }
    if (code !== "TEST" || length < 8) return ABSENT;
    if (dataStart + 8 > bytes.length) return INCOMPLETE;
    const width = view.getInt32(dataStart, true);
    const height = view.getInt32(dataStart + 4, true);
    if (
      width <= 0 ||
      height <= 0 ||
      width > maxDimension ||
      height > maxDimension ||
      length - 8 !== width * height * 4
    ) {
      return ABSENT;
    }
    const pixelsStart = dataStart + 8;
    if (pixelsStart + length - 8 > bytes.length) return INCOMPLETE;
    // Blender stores rows bottom-up.
    const rowBytes = width * 4;
    const rgba = new Uint8Array(rowBytes * height);
    for (let row = 0; row < height; row += 1) {
      const source = pixelsStart + (height - 1 - row) * rowBytes;
      rgba.set(bytes.subarray(source, source + rowBytes), row * rowBytes);
    }
    return { status: "found", width, height, rgba };
  }
}

const READ_CHUNK_BYTES = 64 * 1024;
const ZSTD_MAGIC = 0xfd2fb528;
const GZIP_MAGIC = 0x8b1f;
const ZSTD_SEEKABLE_MAGIC = 0x8f92eab1;
const ZSTD_SEEKABLE_FOOTER_BYTES = 9;
const ZSTD_SKIPPABLE_HEADER_BYTES = 8;
const ZSTD_SEEK_TABLE_MAX_READ_BYTES = 64 * 1024;

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

class GrowableBytes {
  private buffer = new Uint8Array(64 * 1024);
  length = 0;

  append(chunk: Uint8Array) {
    if (this.length + chunk.length > this.buffer.length) {
      const next = new Uint8Array(Math.max(this.buffer.length * 2, this.length + chunk.length));
      next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
    }
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
  }

  view() {
    return this.buffer.subarray(0, this.length);
  }
}

async function readAt(handle: NodeFSP.FileHandle, position: number, length: number) {
  const buffer = new Uint8Array(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function* readRange(handle: NodeFSP.FileHandle, range: ByteRange, signal: AbortSignal) {
  for (let position = range.start; position < range.end;) {
    signal.throwIfAborted();
    const chunk = await readAt(handle, position, Math.min(READ_CHUNK_BYTES, range.end - position));
    if (chunk.length === 0) return;
    position += chunk.length;
    yield chunk;
  }
}

/**
 * Blender writes Zstandard files in the seekable format, one frame per few blocks, and ends the
 * first frame after the thumbnail. Node only decompresses one frame per stream, so each frame is
 * decompressed separately using the seek table when the file has one.
 */
async function zstdFrames(handle: NodeFSP.FileHandle, size: number, inputEnd: number) {
  const whole = [{ start: 0, end: inputEnd }];
  if (size < ZSTD_SEEKABLE_FOOTER_BYTES + ZSTD_SKIPPABLE_HEADER_BYTES) return whole;
  const footer = await readAt(
    handle,
    size - ZSTD_SEEKABLE_FOOTER_BYTES,
    ZSTD_SEEKABLE_FOOTER_BYTES,
  );
  const footerView = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
  if (
    footer.length !== ZSTD_SEEKABLE_FOOTER_BYTES ||
    footerView.getUint32(5, true) !== ZSTD_SEEKABLE_MAGIC
  )
    return whole;
  const frameCount = footerView.getUint32(0, true);
  const entryBytes = (footer[4]! & 0x80) !== 0 ? 12 : 8;
  const tableStart = size - ZSTD_SEEKABLE_FOOTER_BYTES - frameCount * entryBytes;
  if (frameCount === 0 || tableStart < ZSTD_SKIPPABLE_HEADER_BYTES) return whole;
  const table = await readAt(
    handle,
    tableStart,
    Math.min(
      frameCount * entryBytes,
      ZSTD_SEEK_TABLE_MAX_READ_BYTES - (ZSTD_SEEK_TABLE_MAX_READ_BYTES % entryBytes),
    ),
  );
  const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const frames: ByteRange[] = [];
  let start = 0;
  for (
    let offset = 0;
    offset + entryBytes <= table.length && start < inputEnd;
    offset += entryBytes
  ) {
    const compressedBytes = tableView.getUint32(offset, true);
    if (compressedBytes === 0) return whole;
    frames.push({ start, end: Math.min(start + compressedBytes, inputEnd) });
    start += compressedBytes;
  }
  return frames.length > 0 ? frames : whole;
}

/**
 * Returns the PNG for a `.blend` file's saved thumbnail, or `null` when it has none (big-endian and
 * pre-2.50 files), it is one flat color (what background-mode scripts save), or it lies beyond the
 * limits. Reads only the start of the file.
 */
export async function extractBlendThumbnailPng(
  handle: NodeFSP.FileHandle,
  size: number,
  signal: AbortSignal,
  limits: BlendThumbnailLimits = BLEND_THUMBNAIL_LIMITS,
): Promise<Uint8Array | null> {
  const magic = await readAt(handle, 0, 4);
  if (magic.length < 4) return null;
  const magicView = new DataView(magic.buffer, magic.byteOffset, magic.byteLength);
  const inputEnd = Math.min(size, limits.maxInputBytes);
  const isZstd = magicView.getUint32(0, true) === ZSTD_MAGIC;
  const isGzip = magicView.getUint16(0, true) === GZIP_MAGIC;
  const ranges = isZstd ? await zstdFrames(handle, size, inputEnd) : [{ start: 0, end: inputEnd }];
  const scanned = new GrowableBytes();
  let scan: BlendThumbnailScan = INCOMPLETE;

  for (const range of ranges) {
    const source = NodeStream.Readable.from(readRange(handle, range, signal));
    const decompressor = isZstd
      ? NodeZlib.createZstdDecompress()
      : isGzip
        ? NodeZlib.createGunzip()
        : null;
    const stream = decompressor
      ? NodeStream.pipeline(source, decompressor, () => undefined)
      : source;
    try {
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        signal.throwIfAborted();
        scanned.append(chunk.subarray(0, limits.maxScanBytes - scanned.length));
        scan = scanBlendThumbnail(scanned.view(), limits.maxDimension);
        if (scan.status !== "incomplete" || scanned.length >= limits.maxScanBytes) break;
      }
    } finally {
      stream.destroy();
      source.destroy();
    }
    if (scan.status !== "incomplete" || scanned.length >= limits.maxScanBytes) break;
  }
  signal.throwIfAborted();
  return scan.status === "found" && !isUniformRgba(scan.rgba)
    ? encodeRgbaPng(scan.width, scan.height, scan.rgba)
    : null;
}
