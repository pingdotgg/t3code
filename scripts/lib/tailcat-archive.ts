// @effect-diagnostics nodeBuiltinImport:off - archive members are decoded in memory with Node's zlib; nothing here touches the filesystem.
import * as NodeZlib from "node:zlib";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Minimal readers for the two archive formats upstream Tailcat releases use
 * (`.tar.gz` on Linux, `.zip` on Windows). They exist so the fetch script does
 * not depend on `tar` or `unzip` being installed, behaves identically on every
 * CI runner, and only ever materializes the members it asked for.
 */

export type TailcatArchiveFormat = "tar.gz" | "zip";

export function tailcatArchiveFormat(fileName: string): TailcatArchiveFormat | undefined {
  if (fileName.endsWith(".tar.gz") || fileName.endsWith(".tgz")) return "tar.gz";
  if (fileName.endsWith(".zip")) return "zip";
  return undefined;
}

export const TailcatArchiveReason = Schema.Literals([
  "unsupported-format",
  "corrupt",
  "unsupported-compression",
  "checksum-mismatch",
  "entry-missing",
  "entry-ambiguous",
]);
export type TailcatArchiveReason = typeof TailcatArchiveReason.Type;

export class TailcatArchiveError extends Schema.TaggedErrorClass<TailcatArchiveError>()(
  "TailcatArchiveError",
  {
    archive: Schema.String,
    reason: TailcatArchiveReason,
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.detail === undefined ? "" : ` (${this.detail})`;
    return `Could not read Tailcat archive ${this.archive}: ${this.reason}${detail}`;
  }
}

export interface ArchiveMember {
  readonly name: string;
  readonly data: Uint8Array;
}

class ArchiveParseError extends Error {
  readonly reason: TailcatArchiveReason;
  readonly detail: string;

  constructor(reason: TailcatArchiveReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

const textDecoder = new TextDecoder();

// --- tar ------------------------------------------------------------------

const TAR_BLOCK_SIZE = 512;

function readTarString(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return textDecoder.decode(end === -1 ? field : field.subarray(0, end));
}

function readTarNumber(block: Uint8Array, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  const first = field[0];
  if (first !== undefined && (first & 0x80) !== 0) {
    // GNU base-256 encoding for values that do not fit the octal field.
    let value = first & 0x7f;
    for (let index = 1; index < field.length; index++) {
      value = value * 256 + (field[index] ?? 0);
    }
    return value;
  }
  const text = readTarString(block, offset, length).trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/u.test(text)) {
    throw new ArchiveParseError("corrupt", `invalid numeric header field "${text}"`);
  }
  return Number.parseInt(text, 8);
}

/** Reads the `path` record from a pax extended header (`<length> <key>=<value>\n` per record). */
function parsePaxPath(record: Uint8Array): string | undefined {
  let offset = 0;
  let path: string | undefined;
  while (offset < record.length) {
    const space = record.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(textDecoder.decode(record.subarray(offset, space)), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const body = textDecoder
      .decode(record.subarray(space + 1, offset + length))
      .replace(/\n$/u, "");
    const separator = body.indexOf("=");
    if (separator !== -1 && body.slice(0, separator) === "path") {
      path = body.slice(separator + 1);
    }
    offset += length;
  }
  return path;
}

function readTarMembers(tar: Uint8Array): ReadonlyArray<ArchiveMember> {
  const members: ArchiveMember[] = [];
  let offset = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;

  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const size = readTarNumber(header, 124, 12);
    const typeflag = header[156] ?? 0;
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new ArchiveParseError("corrupt", "member data extends past the end of the archive");
    }
    const data = tar.subarray(dataStart, dataEnd);

    switch (typeflag) {
      // 'L': GNU long name for the next member.
      case 0x4c:
        longName = readTarString(data, 0, data.length);
        break;
      // 'x': pax extended header for the next member.
      case 0x78:
        paxPath = parsePaxPath(data) ?? paxPath;
        break;
      // 'g': pax global header, nothing we need.
      case 0x67:
        break;
      // '0' or NUL: regular file.
      case 0x30:
      case 0x00: {
        const prefix = readTarString(header, 345, 155);
        const shortName = readTarString(header, 0, 100);
        const name =
          paxPath ?? longName ?? (prefix.length > 0 ? `${prefix}/${shortName}` : shortName);
        members.push({ name, data: data.slice() });
        longName = undefined;
        paxPath = undefined;
        break;
      }
      // Directories, links, devices: skip, and drop any pending name override.
      default:
        longName = undefined;
        paxPath = undefined;
        break;
    }

    offset = dataEnd + ((TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE);
  }

  return members;
}

// --- zip ------------------------------------------------------------------

const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_MARKER = 0xffffffff;

function inflateZipMember(name: string, method: number, compressed: Uint8Array): Uint8Array {
  switch (method) {
    case 0:
      return compressed.slice();
    case 8: {
      const inflated: Uint8Array = NodeZlib.inflateRawSync(compressed);
      return inflated;
    }
    default:
      throw new ArchiveParseError(
        "unsupported-compression",
        `member ${name} uses compression method ${method}`,
      );
  }
}

function readZipMembers(zip: Uint8Array): ReadonlyArray<ArchiveMember> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  let endOfCentralDirectory = -1;
  const searchFloor = Math.max(
    0,
    zip.length - ZIP_END_OF_CENTRAL_DIRECTORY_SIZE - ZIP_MAX_COMMENT_LENGTH,
  );
  for (let index = zip.length - ZIP_END_OF_CENTRAL_DIRECTORY_SIZE; index >= searchFloor; index--) {
    if (view.getUint32(index, true) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      endOfCentralDirectory = index;
      break;
    }
  }
  if (endOfCentralDirectory === -1) {
    throw new ArchiveParseError("corrupt", "end of central directory record not found");
  }

  const entryCount = view.getUint16(endOfCentralDirectory + 10, true);
  const directoryOffset = view.getUint32(endOfCentralDirectory + 16, true);
  if (entryCount === 0xffff || directoryOffset === ZIP64_MARKER) {
    throw new ArchiveParseError("unsupported-compression", "zip64 archives are not supported");
  }

  const members: ArchiveMember[] = [];
  let position = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (
      position + 46 > zip.length ||
      view.getUint32(position, true) !== ZIP_CENTRAL_HEADER_SIGNATURE
    ) {
      throw new ArchiveParseError("corrupt", "central directory entry is malformed");
    }
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const crc32 = view.getUint32(position + 16, true);
    const compressedSize = view.getUint32(position + 20, true);
    const uncompressedSize = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localHeaderOffset = view.getUint32(position + 42, true);
    const name = textDecoder.decode(zip.subarray(position + 46, position + 46 + nameLength));
    position += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;
    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localHeaderOffset === ZIP64_MARKER
    ) {
      throw new ArchiveParseError("unsupported-compression", `zip64 member ${name}`);
    }
    if ((flags & 0x1) !== 0) {
      throw new ArchiveParseError("unsupported-compression", `encrypted member ${name}`);
    }
    if (
      localHeaderOffset + 30 > zip.length ||
      view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_HEADER_SIGNATURE
    ) {
      throw new ArchiveParseError("corrupt", `local header for ${name} is malformed`);
    }

    // Sizes come from the central directory: local headers may carry zeros
    // when the writer streamed the member and appended a data descriptor.
    const dataStart =
      localHeaderOffset +
      30 +
      view.getUint16(localHeaderOffset + 26, true) +
      view.getUint16(localHeaderOffset + 28, true);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) {
      throw new ArchiveParseError("corrupt", `member ${name} extends past the end of the archive`);
    }

    const data = inflateZipMember(name, method, zip.subarray(dataStart, dataEnd));
    if (data.length !== uncompressedSize || NodeZlib.crc32(data) !== crc32) {
      throw new ArchiveParseError("checksum-mismatch", name);
    }
    members.push({ name, data });
  }

  return members;
}

// --- public ---------------------------------------------------------------

/**
 * Extracts the regular-file members whose base name is in `wanted`, keyed by
 * that base name. Matching by base name tolerates a future upstream layout that
 * nests members in a versioned directory; two members sharing a base name is an
 * error rather than a silent pick.
 */
export const extractArchiveEntries = Effect.fn("extractArchiveEntries")(function* (input: {
  readonly archive: string;
  readonly bytes: Uint8Array;
  readonly format: TailcatArchiveFormat;
  readonly wanted: ReadonlyArray<string>;
}) {
  const members = yield* Effect.try({
    try: () =>
      input.format === "tar.gz"
        ? readTarMembers(NodeZlib.gunzipSync(input.bytes))
        : readZipMembers(input.bytes),
    catch: (cause) =>
      cause instanceof ArchiveParseError
        ? new TailcatArchiveError({
            archive: input.archive,
            reason: cause.reason,
            detail: cause.detail,
          })
        : new TailcatArchiveError({ archive: input.archive, reason: "corrupt", cause }),
  });

  const entries = new Map<string, Uint8Array>();
  for (const member of members) {
    const baseName = member.name.split("/").at(-1) ?? member.name;
    if (!input.wanted.includes(baseName)) continue;
    if (entries.has(baseName)) {
      return yield* new TailcatArchiveError({
        archive: input.archive,
        reason: "entry-ambiguous",
        detail: baseName,
      });
    }
    entries.set(baseName, member.data);
  }
  return entries;
});
