import type { ImageDimensions } from "@t3tools/shared/imageDimensions";

/** Reads up to `length` bytes at `offset`; a short result means end of file. */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

// Bounds the reads a malformed or hostile file can cause.
const MAX_ELEMENTS_PER_LEVEL = 64;

/**
 * The display size of the first video track in an MP4/MOV or WebM/Matroska
 * file. Reads only element headers by offset, so an MP4 whose `moov` box sits
 * after the media data costs a few small reads, not the whole file.
 */
export async function readVideoDimensions(
  read: ReadAt,
  fileSize: number,
): Promise<ImageDimensions | null> {
  const head = await read(0, 12);
  const dimensions =
    head.length >= 8 && ISO_BMFF_FIRST_BOXES.has(ascii(head, 4, 8))
      ? await readIsoBmff(read, fileSize)
      : head.length >= 4 && view(head).getUint32(0) === EBML_HEADER
        ? await readMatroska(read, fileSize)
        : null;
  return dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : null;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

// QuickTime files may predate `ftyp` and open with another top-level box.
const ISO_BMFF_FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip"]);

interface Box {
  readonly type: string;
  readonly bodyStart: number;
  readonly end: number;
}

async function* isoBoxes(read: ReadAt, start: number, end: number): AsyncGenerator<Box> {
  let offset = start;
  for (let index = 0; index < MAX_ELEMENTS_PER_LEVEL && offset + 8 <= end; index += 1) {
    const header = await read(offset, 16);
    if (header.length < 8) return;
    const data = view(header);
    let size = data.getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) return;
      size = Number(data.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return;
    yield { type: ascii(header, 4, 8), bodyStart: offset + headerSize, end: offset + size };
    offset += size;
  }
}

async function readIsoBmff(read: ReadAt, fileSize: number): Promise<ImageDimensions | null> {
  for await (const box of isoBoxes(read, 0, fileSize)) {
    if (box.type !== "moov") continue;
    for await (const track of isoBoxes(read, box.bodyStart, box.end)) {
      if (track.type !== "trak") continue;
      let dimensions: ImageDimensions | null = null;
      let handler: string | null = null;
      for await (const child of isoBoxes(read, track.bodyStart, track.end)) {
        if (child.type === "tkhd") {
          dimensions = readTrackHeader(
            await read(child.bodyStart, Math.min(TRACK_HEADER_BYTES, child.end - child.bodyStart)),
          );
        } else if (child.type === "mdia") {
          handler = await readHandlerType(read, child);
        }
      }
      // Subtitle and chapter text tracks can carry a nonzero size of their own.
      if (handler === "vide" && dimensions) return dimensions;
    }
    return null;
  }
  return null;
}

async function readHandlerType(read: ReadAt, media: Box): Promise<string | null> {
  for await (const child of isoBoxes(read, media.bodyStart, media.end)) {
    if (child.type !== "hdlr") continue;
    // Version and flags, then `pre_defined`, then the four-character handler type.
    const handler = await read(child.bodyStart + 8, 4);
    return handler.length === 4 ? ascii(handler, 0, 4) : null;
  }
  return null;
}

// A version 1 `tkhd` ends its width and height 96 bytes into the body.
const TRACK_HEADER_BYTES = 96;

function readTrackHeader(body: Uint8Array): ImageDimensions | null {
  const matrixOffset = body[0] === 1 ? 52 : 40;
  if (body.length < matrixOffset + 44) return null;
  const data = view(body);
  const width = Math.round(data.getUint32(matrixOffset + 36) / 0x10000);
  const height = Math.round(data.getUint32(matrixOffset + 40) / 0x10000);
  if (width === 0 || height === 0) return null;
  // Phone recordings store landscape frames with a 90° or 270° display matrix.
  const rotatedQuarterTurn =
    data.getInt32(matrixOffset) === 0 && data.getInt32(matrixOffset + 4) !== 0;
  return rotatedQuarterTurn ? { width: height, height: width } : { width, height };
}

const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const TRACK_TYPE_VIDEO = 1;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;
const DISPLAY_WIDTH = 0x54b0;
const DISPLAY_HEIGHT = 0x54ba;
const DISPLAY_UNIT = 0x54b2;

interface Element {
  readonly id: number;
  readonly bodyStart: number;
  /** `null` when the size is unknown, as in a live WebM recording. */
  readonly end: number | null;
}

function vintLength(firstByte: number | undefined): number {
  if (firstByte === undefined || firstByte === 0) return 0;
  return Math.clz32(firstByte) - 23;
}

async function* ebmlElements(read: ReadAt, start: number, end: number): AsyncGenerator<Element> {
  let offset = start;
  for (let index = 0; index < MAX_ELEMENTS_PER_LEVEL && offset < end; index += 1) {
    const header = await read(offset, 12);
    const idLength = vintLength(header[0]);
    if (idLength === 0 || idLength > 4) return;
    const sizeLength = vintLength(header[idLength]);
    if (sizeLength === 0 || idLength + sizeLength > header.length) return;
    let id = 0;
    for (let byte = 0; byte < idLength; byte += 1) id = id * 0x100 + header[byte]!;
    let size = header[idLength]! & (0xff >> sizeLength);
    let unknown = size === 0xff >> sizeLength;
    for (let byte = 1; byte < sizeLength; byte += 1) {
      const value = header[idLength + byte]!;
      size = size * 0x100 + value;
      unknown &&= value === 0xff;
    }
    const bodyStart = offset + idLength + sizeLength;
    if (unknown) {
      yield { id, bodyStart, end: null };
      return;
    }
    if (bodyStart + size > end) return;
    yield { id, bodyStart, end: bodyStart + size };
    offset = bodyStart + size;
  }
}

async function readUnsigned(read: ReadAt, element: Element): Promise<number | null> {
  if (element.end === null || element.end - element.bodyStart > 6) return null;
  const bytes = await read(element.bodyStart, element.end - element.bodyStart);
  return bytes.reduce((value, byte) => value * 0x100 + byte, 0);
}

async function readMatroska(read: ReadAt, fileSize: number): Promise<ImageDimensions | null> {
  for await (const top of ebmlElements(read, 0, fileSize)) {
    if (top.id !== SEGMENT) continue;
    for await (const child of ebmlElements(read, top.bodyStart, top.end ?? fileSize)) {
      if (child.id === CLUSTER || child.end === null) return null;
      if (child.id !== TRACKS) continue;
      for await (const entry of ebmlElements(read, child.bodyStart, child.end)) {
        if (entry.id !== TRACK_ENTRY || entry.end === null) continue;
        const dimensions = await readMatroskaTrack(read, entry.bodyStart, entry.end);
        if (dimensions) return dimensions;
      }
      return null;
    }
    return null;
  }
  return null;
}

async function readMatroskaTrack(
  read: ReadAt,
  start: number,
  end: number,
): Promise<ImageDimensions | null> {
  let trackType: number | null = null;
  let video: Element | null = null;
  for await (const element of ebmlElements(read, start, end)) {
    if (element.id === TRACK_TYPE) trackType = await readUnsigned(read, element);
    if (element.id === VIDEO) video = element;
  }
  if (trackType !== TRACK_TYPE_VIDEO || video === null || video.end === null) return null;
  const values = new Map<number, number | null>();
  for await (const element of ebmlElements(read, video.bodyStart, video.end)) {
    values.set(element.id, await readUnsigned(read, element));
  }
  const displayWidth = values.get(DISPLAY_WIDTH);
  const displayHeight = values.get(DISPLAY_HEIGHT);
  if ((values.get(DISPLAY_UNIT) ?? 0) === 0 && displayWidth && displayHeight) {
    return { width: displayWidth, height: displayHeight };
  }
  const width = values.get(PIXEL_WIDTH);
  const height = values.get(PIXEL_HEIGHT);
  return width && height ? { width, height } : null;
}
