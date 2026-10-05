import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

/**
 * Read-only decoder for a Chromium profile's `Local Storage/leveldb`.
 *
 * It reads the database files directly and never takes LevelDB's lock, so it
 * works while another app version has the profile open. Live files come from
 * the MANIFEST that CURRENT names, and the newest sequence number wins, which
 * is how LevelDB itself resolves overwrites and deletions.
 */

const LOG_BLOCK_SIZE = 32 * 1024;
const LOG_HEADER_SIZE = 7;
const TABLE_FOOTER_SIZE = 48;
const BLOCK_TRAILER_SIZE = 5;

class LevelDbFormatError extends Schema.TaggedError<LevelDbFormatError>()("LevelDbFormatError", {
  detail: Schema.String,
}) {}

const isLevelDbFormatError = Schema.is(LevelDbFormatError);

const fail = (detail: string): never => {
  throw new LevelDbFormatError({ detail });
};

// ignoreBOM keeps a leading U+FEFF that is part of the stored string.
const textDecoderUtf16 = new TextDecoder("utf-16le", { ignoreBOM: true });
const textDecoderUtf8 = new TextDecoder();

/** True ISO-8859-1. WHATWG's "latin1" label is windows-1252, which remaps 0x80-0x9F. */
function decodeLatin1(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return result;
}

class Reader {
  readonly bytes: Uint8Array;
  offset: number;
  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }
  get done() {
    return this.offset >= this.bytes.length;
  }
  byte(): number {
    if (this.offset >= this.bytes.length) fail("unexpected end of data");
    return this.bytes[this.offset++]!;
  }
  varint(): number {
    let result = 0;
    let multiplier = 1;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = this.byte();
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return result;
      multiplier *= 128;
    }
    return fail("varint too long");
  }
  take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) fail("length out of range");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }
  lengthPrefixed(): Uint8Array {
    return this.take(this.varint());
  }
}

const readUint32 = (bytes: Uint8Array, offset: number) =>
  (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) +
  bytes[offset + 3]! * 0x1000000;

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    table[index] = crc >>> 0;
  }
  return table;
})();

function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32C_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** LevelDB stores CRCs masked so a CRC of data containing CRCs stays well distributed. */
const unmaskCrc = (masked: number) => {
  const rotated = (masked - 0xa282ead8) >>> 0;
  return ((rotated >>> 17) | (rotated << 15)) >>> 0;
};

function decompressSnappy(input: Uint8Array): Uint8Array {
  const reader = new Reader(input);
  const output = new Uint8Array(reader.varint());
  let written = 0;
  while (!reader.done) {
    const tag = reader.byte();
    const kind = tag & 3;
    if (kind === 0) {
      let length = tag >>> 2;
      if (length >= 60) {
        const extraBytes = length - 59;
        length = 0;
        for (let index = 0; index < extraBytes; index++) length += reader.byte() * 256 ** index;
      }
      length += 1;
      if (written + length > output.length) fail("snappy literal overflows output");
      output.set(reader.take(length), written);
      written += length;
      continue;
    }
    let length: number;
    let offset: number;
    if (kind === 1) {
      length = 4 + ((tag >>> 2) & 7);
      offset = ((tag >>> 5) << 8) | reader.byte();
    } else if (kind === 2) {
      length = (tag >>> 2) + 1;
      offset = reader.byte() | (reader.byte() << 8);
    } else {
      length = (tag >>> 2) + 1;
      offset = readUint32(reader.take(4), 0);
    }
    if (offset === 0 || offset > written || written + length > output.length) {
      fail("snappy copy out of range");
    }
    // Copies may overlap their own output, so they go byte by byte.
    for (let index = 0; index < length; index++) {
      output[written] = output[written - offset]!;
      written++;
    }
  }
  if (written !== output.length) fail("snappy output length mismatch");
  return output;
}

/**
 * Splits a LevelDB log (write-ahead log or MANIFEST) into its records. Like
 * LevelDB's own reader, a corrupt record or zero padding skips the rest of its
 * block, since a reused log keeps appending after a torn write, and a record
 * cut off by the end of the file ends the log.
 */
function readLogRecords(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  let pending: Uint8Array[] | null = null;
  let offset = 0;
  while (offset + LOG_HEADER_SIZE <= bytes.length) {
    const blockRemaining = LOG_BLOCK_SIZE - (offset % LOG_BLOCK_SIZE);
    if (blockRemaining < LOG_HEADER_SIZE) {
      offset += blockRemaining;
      continue;
    }
    const length = bytes[offset + 4]! | (bytes[offset + 5]! << 8);
    const type = bytes[offset + 6]!;
    const end = offset + LOG_HEADER_SIZE + length;
    const fitsBlock = LOG_HEADER_SIZE + length <= blockRemaining;
    if (fitsBlock && end > bytes.length) break;
    const typeAndPayload = bytes.subarray(offset + 6, end);
    if (
      type === 0 ||
      !fitsBlock ||
      crc32c(typeAndPayload) !== unmaskCrc(readUint32(bytes, offset))
    ) {
      offset += blockRemaining;
      pending = null;
      continue;
    }
    const payload = typeAndPayload.subarray(1);
    offset = end;
    if (type === 1) {
      records.push(payload);
      pending = null;
    } else if (type === 2) {
      pending = [payload];
    } else if (type === 3 && pending) {
      pending.push(payload);
    } else if (type === 4 && pending) {
      pending.push(payload);
      const total = pending.reduce((sum, part) => sum + part.length, 0);
      const record = new Uint8Array(total);
      let position = 0;
      for (const part of pending) {
        record.set(part, position);
        position += part.length;
      }
      records.push(record);
      pending = null;
    } else {
      pending = null;
    }
  }
  return records;
}

interface LiveFiles {
  readonly tables: ReadonlyArray<number>;
  readonly logNumber: number;
  readonly previousLogNumber: number;
}

/** Replays MANIFEST version edits to find the live table files and log. */
function readManifest(bytes: Uint8Array): LiveFiles {
  const tables = new Set<number>();
  let logNumber = 0;
  let previousLogNumber = 0;
  // LevelDB refuses to open a MANIFEST missing any of these, and so do we.
  const required = new Set([2, 3, 4]);
  for (const record of readLogRecords(bytes)) {
    const reader = new Reader(record);
    while (!reader.done) {
      const tag = reader.varint();
      required.delete(tag);
      switch (tag) {
        case 1: // comparator
          reader.lengthPrefixed();
          break;
        case 2:
          logNumber = reader.varint();
          break;
        case 3: // next file number
        case 4: // last sequence
          reader.varint();
          break;
        case 5: // compaction pointer
          reader.varint();
          reader.lengthPrefixed();
          break;
        case 6: // deleted file
          reader.varint();
          tables.delete(reader.varint());
          break;
        case 7: {
          reader.varint();
          tables.add(reader.varint());
          reader.varint();
          reader.lengthPrefixed();
          reader.lengthPrefixed();
          break;
        }
        case 9:
          previousLogNumber = reader.varint();
          break;
        default:
          fail(`unknown manifest tag ${tag}`);
      }
    }
  }
  if (required.size > 0) fail("incomplete manifest");
  return { tables: [...tables], logNumber, previousLogNumber };
}

interface VersionedEntry {
  readonly sequence: number;
  /** `null` marks a deletion. */
  readonly value: Uint8Array | null;
}

type EntryMap = Map<string, { readonly key: Uint8Array; readonly entry: VersionedEntry }>;

const keyId = decodeLatin1;

function record(entries: EntryMap, key: Uint8Array, entry: VersionedEntry) {
  const id = keyId(key);
  const existing = entries.get(id);
  if (!existing || existing.entry.sequence < entry.sequence) entries.set(id, { key, entry });
}

/** Applies one write-ahead log record (a WriteBatch). */
function readWriteBatch(entries: EntryMap, batch: Uint8Array) {
  if (batch.length < 12) fail("write batch too short");
  // The sequence is a little-endian uint64; real values stay far below 2^53.
  const sequence = readUint32(batch, 0) + readUint32(batch, 4) * 0x100000000;
  const count = readUint32(batch, 8);
  const reader = new Reader(batch, 12);
  for (let index = 0; index < count; index++) {
    const type = reader.byte();
    const key = reader.lengthPrefixed();
    if (type === 1) {
      record(entries, key, { sequence: sequence + index, value: reader.lengthPrefixed() });
    } else if (type === 0) {
      record(entries, key, { sequence: sequence + index, value: null });
    } else {
      fail(`unknown write batch record type ${type}`);
    }
  }
}

function readBlock(table: Uint8Array, reader: Reader): Uint8Array {
  const offset = reader.varint();
  const size = reader.varint();
  if (offset + size + BLOCK_TRAILER_SIZE > table.length) fail("block handle out of range");
  const contents = table.subarray(offset, offset + size);
  const compression = table[offset + size]!;
  const checksum = unmaskCrc(readUint32(table, offset + size + 1));
  if (crc32c(table.subarray(offset, offset + size + 1)) !== checksum) fail("block checksum");
  if (compression === 0) return contents;
  if (compression === 1) return decompressSnappy(contents);
  return fail(`unsupported block compression ${compression}`);
}

function* blockEntries(block: Uint8Array): Generator<[Uint8Array, Uint8Array]> {
  if (block.length < 4) fail("block too short");
  const restartCount = readUint32(block, block.length - 4);
  const limit = block.length - 4 - restartCount * 4;
  if (limit < 0) fail("restart array out of range");
  const reader = new Reader(block.subarray(0, limit));
  let key = new Uint8Array(0);
  while (!reader.done) {
    const shared = reader.varint();
    const unshared = reader.varint();
    const valueLength = reader.varint();
    if (shared > key.length) fail("block key prefix out of range");
    const nextKey = new Uint8Array(shared + unshared);
    nextKey.set(key.subarray(0, shared));
    nextKey.set(reader.take(unshared), shared);
    key = nextKey;
    yield [key, reader.take(valueLength)];
  }
}

/** Applies every entry in one sorted table (`.ldb`/`.sst`) file. */
function readTable(entries: EntryMap, table: Uint8Array) {
  if (table.length < TABLE_FOOTER_SIZE) fail("table too short");
  const footer = new Reader(table, table.length - TABLE_FOOTER_SIZE);
  footer.varint();
  footer.varint();
  const index = readBlock(table, footer);
  for (const [, handle] of blockEntries(index)) {
    const block = readBlock(table, new Reader(handle));
    for (const [internalKey, value] of blockEntries(block)) {
      if (internalKey.length < 8) fail("internal key too short");
      const trailerOffset = internalKey.length - 8;
      const trailer =
        readUint32(internalKey, trailerOffset) +
        readUint32(internalKey, trailerOffset + 4) * 0x100000000;
      const type = trailer % 256;
      const sequence = Math.floor(trailer / 256);
      const key = internalKey.subarray(0, trailerOffset);
      record(entries, key, { sequence, value: type === 1 ? value : null });
    }
  }
}

/** Chromium prefixes each stored string with 0 (UTF-16LE) or 1 (Latin-1). */
function decodeChromiumString(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  const body = bytes.subarray(1);
  if (bytes[0] === 1) return decodeLatin1(body);
  if (bytes[0] === 0 && body.length % 2 === 0) return textDecoderUtf16.decode(body);
  return null;
}

export class ChromiumLocalStorageReadError extends Schema.TaggedError<ChromiumLocalStorageReadError>()(
  "ChromiumLocalStorageReadError",
  {
    directory: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not read Chromium Local Storage at ${this.directory}.`;
  }
}

/**
 * Returns the localStorage items one origin (for example `t3code://app`) had
 * in the profile, or an empty map when the profile never stored any.
 */
export const readChromiumLocalStorage = Effect.fn("desktop.chromiumLocalStorage.read")(function* (
  directory: string,
  origin: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readFile = (name: string) => fs.readFile(path.join(directory, name));
  const wrap = Effect.mapError(
    (cause: PlatformError.PlatformError | LevelDbFormatError) =>
      new ChromiumLocalStorageReadError({ directory, cause }),
  );
  const decode = <A>(run: () => A) =>
    Effect.try({
      try: run,
      catch: (cause) =>
        isLevelDbFormatError(cause) ? cause : new LevelDbFormatError({ detail: String(cause) }),
    });

  const current = textDecoderUtf8.decode(yield* readFile("CURRENT").pipe(wrap)).trim();
  if (!/^MANIFEST-\d+$/.test(current)) {
    return yield* new ChromiumLocalStorageReadError({
      directory,
      cause: new LevelDbFormatError({ detail: "bad CURRENT" }),
    });
  }
  const manifest = yield* readFile(current).pipe(wrap);
  const live = yield* decode(() => readManifest(manifest)).pipe(wrap);
  const logs = (yield* fs.readDirectory(directory).pipe(wrap))
    .map((name) => /^(\d+)\.log$/.exec(name))
    // The logs LevelDB's own recovery replays.
    .filter((match) => {
      const number = Number(match?.[1]);
      return number >= live.logNumber || number === live.previousLogNumber;
    })
    .map((match) => match![0]);

  const entries: EntryMap = new Map();
  for (const number of live.tables) {
    const name = String(number).padStart(6, "0");
    // Newer LevelDB names tables .ldb; older databases may still hold .sst files.
    const bytes = yield* readFile(`${name}.ldb`).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => readFile(`${name}.sst`),
      ),
      wrap,
    );
    yield* decode(() => readTable(entries, bytes)).pipe(wrap);
  }
  for (const name of logs) {
    const bytes = yield* readFile(name).pipe(wrap);
    yield* decode(() => {
      for (const batch of readLogRecords(bytes)) readWriteBatch(entries, batch);
    }).pipe(wrap);
  }

  // A flush while another process has the database open can move entries
  // from a log we read into a table our MANIFEST copy predates. Fail so the
  // caller retries rather than import a snapshot missing those entries.
  const currentAfter = textDecoderUtf8.decode(yield* readFile("CURRENT").pipe(wrap)).trim();
  const manifestAfter = yield* fs.stat(path.join(directory, current)).pipe(wrap);
  if (currentAfter !== current || Number(manifestAfter.size) !== manifest.length) {
    return yield* new ChromiumLocalStorageReadError({
      directory,
      cause: new LevelDbFormatError({ detail: "database changed while reading" }),
    });
  }

  const prefix = `_${origin}\u0000`;
  const items = new Map<string, string>();
  for (const [id, { key: rawKey, entry }] of entries) {
    if (!id.startsWith(prefix) || entry.value === null) continue;
    const key = decodeChromiumString(rawKey.subarray(prefix.length));
    const value = decodeChromiumString(entry.value);
    if (key !== null && value !== null) items.set(key, value);
  }
  return items;
});
