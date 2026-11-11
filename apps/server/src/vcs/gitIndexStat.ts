// @effect-diagnostics nodeBuiltinImport:off - Pure helpers; the index checksum is SHA-1 over bytes.
import * as NodeCrypto from "node:crypto";

/** What Git compares in an index entry's stat data. Numbers are already truncated to 32 bits. */
export interface IndexEntryStat {
  readonly ctimeSeconds: number;
  readonly ctimeNanoseconds: number;
  readonly mtimeSeconds: number;
  readonly mtimeNanoseconds: number;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly kind: "file" | "executable" | "symlink" | "directory" | "other";
}

export interface ParsedIndex {
  readonly bytes: Uint8Array;
  readonly entries: ReadonlyArray<{ readonly offset: number; readonly path: string }>;
}

const ENTRY_FIXED_BYTES = 62;
const SHA1_BYTES = 20;
const MODE_TYPE_MASK = 0o170000;
const MODE_REGULAR = 0o100000;
const MODE_SYMLINK = 0o120000;
const MODE_GITLINK = 0o160000;
const FLAG_ASSUME_VALID = 0x8000;
const FLAG_EXTENDED = 0x4000;
const FLAG_STAGE = 0x3000;
const FLAG_NAME_LENGTH = 0x0fff;
const EXTENDED_SKIP_WORKTREE = 0x4000;
// Extensions that let Git trust an entry without checking the file, or that point at another index.
const UNSAFE_EXTENSIONS = new Set(["link", "FSMN", "sdir", "UNTR"]);

const decoder = new TextDecoder();

/**
 * Reads a SHA-1 index that T3 wrote itself (versions 2 and 3). Anything else, including
 * conflicts, sparse entries, split indexes and fsmonitor data, returns null so callers use Git.
 */
export function parseIndex(bytes: Uint8Array): ParsedIndex | null {
  if (bytes.length < 12 + SHA1_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (decoder.decode(bytes.subarray(0, 4)) !== "DIRC") return null;
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) return null;
  const expected = NodeCrypto.createHash("sha1")
    .update(bytes.subarray(0, bytes.length - SHA1_BYTES))
    .digest();
  if (!expected.equals(bytes.subarray(bytes.length - SHA1_BYTES))) return null;

  const count = view.getUint32(8);
  const entries: Array<{ offset: number; path: string }> = [];
  let offset = 12;
  for (let index = 0; index < count; index++) {
    if (offset + ENTRY_FIXED_BYTES > bytes.length - SHA1_BYTES) return null;
    const flags = view.getUint16(offset + 60);
    if (flags & (FLAG_ASSUME_VALID | FLAG_STAGE)) return null;
    let nameStart = offset + ENTRY_FIXED_BYTES;
    if (flags & FLAG_EXTENDED) {
      if (version < 3 || view.getUint16(nameStart) & EXTENDED_SKIP_WORKTREE) return null;
      nameStart += 2;
    }
    const nameLength = flags & FLAG_NAME_LENGTH;
    const nameEnd =
      nameLength < FLAG_NAME_LENGTH ? nameStart + nameLength : bytes.indexOf(0, nameStart);
    if (nameEnd < 0 || bytes[nameEnd] !== 0) return null;
    entries.push({ offset, path: decoder.decode(bytes.subarray(nameStart, nameEnd)) });
    // Entries are NUL-padded to a multiple of eight bytes, with at least one NUL.
    offset += (nameEnd - offset + 8) & ~7;
  }

  // Extensions follow the entries as a 4-byte signature and a 4-byte length.
  while (offset < bytes.length - SHA1_BYTES) {
    if (offset + 8 > bytes.length - SHA1_BYTES) return null;
    if (UNSAFE_EXTENSIONS.has(decoder.decode(bytes.subarray(offset, offset + 4)))) return null;
    offset += 8 + view.getUint32(offset + 4);
  }
  return offset === bytes.length - SHA1_BYTES ? { bytes, entries } : null;
}

function kindForMode(mode: number): IndexEntryStat["kind"] {
  switch (mode & MODE_TYPE_MASK) {
    case MODE_REGULAR:
      return mode & 0o111 ? "executable" : "file";
    case MODE_SYMLINK:
      return "symlink";
    case MODE_GITLINK:
      return "directory";
    default:
      return "other";
  }
}

/**
 * Returns a copy of the index with each entry's stat data replaced by `stats[i]`, so Git trusts
 * files it did not write itself. With `verify`, an entry whose recorded mtime, size or type
 * differs from its file makes the result null: the files no longer match what Git checked out.
 * A missing stat (an uninitialized submodule folder) keeps the entry's recorded data.
 */
export function restatIndex(
  parsed: ParsedIndex,
  stats: ReadonlyArray<IndexEntryStat | undefined>,
  options: { readonly verify: boolean },
): Uint8Array | null {
  const bytes = new Uint8Array(parsed.bytes);
  const view = new DataView(bytes.buffer);
  // Two tracked paths on one file, as on a case-insensitive volume, cannot both match.
  const files = new Set<string>();
  for (const [index, entry] of parsed.entries.entries()) {
    const stat = stats[index];
    const offset = entry.offset;
    const kind = kindForMode(view.getUint32(offset + 24));
    if (stat === undefined) {
      if (kind !== "directory") return null;
      continue;
    }
    if (stat.kind !== kind) return null;
    if (kind !== "directory") {
      const file = `${stat.dev}:${stat.ino}`;
      if (files.has(file)) return null;
      files.add(file);
    }
    if (
      options.verify &&
      kind !== "directory" &&
      (view.getUint32(offset + 8) !== stat.mtimeSeconds ||
        view.getUint32(offset + 12) !== stat.mtimeNanoseconds ||
        view.getUint32(offset + 36) !== stat.size)
    ) {
      return null;
    }
    view.setUint32(offset, stat.ctimeSeconds);
    view.setUint32(offset + 4, stat.ctimeNanoseconds);
    view.setUint32(offset + 8, stat.mtimeSeconds);
    view.setUint32(offset + 12, stat.mtimeNanoseconds);
    view.setUint32(offset + 16, stat.dev);
    view.setUint32(offset + 20, stat.ino);
    view.setUint32(offset + 28, stat.uid);
    view.setUint32(offset + 32, stat.gid);
    view.setUint32(offset + 36, stat.size);
  }
  bytes.set(
    NodeCrypto.createHash("sha1")
      .update(bytes.subarray(0, bytes.length - SHA1_BYTES))
      .digest(),
    bytes.length - SHA1_BYTES,
  );
  return bytes;
}

const U32 = 0xffff_ffffn;
const BILLION = 1_000_000_000n;

/** Converts a bigint `lstat` result the way Git does: each field truncated to 32 bits. */
export function indexEntryStat(stat: {
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly size: bigint;
  readonly mode: bigint;
}): IndexEntryStat {
  const type = Number(stat.mode) & MODE_TYPE_MASK;
  return {
    ctimeSeconds: Number((stat.ctimeNs / BILLION) & U32),
    ctimeNanoseconds: Number(stat.ctimeNs % BILLION),
    mtimeSeconds: Number((stat.mtimeNs / BILLION) & U32),
    mtimeNanoseconds: Number(stat.mtimeNs % BILLION),
    dev: Number(stat.dev & U32),
    ino: Number(stat.ino & U32),
    uid: Number(stat.uid & U32),
    gid: Number(stat.gid & U32),
    size: Number(stat.size & U32),
    kind:
      type === MODE_REGULAR
        ? Number(stat.mode) & 0o111
          ? "executable"
          : "file"
        : type === MODE_SYMLINK
          ? "symlink"
          : type === 0o040000
            ? "directory"
            : "other",
  };
}
