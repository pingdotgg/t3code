/**
 * Git object codec: oid hashing, loose headers, commit/tree/tag parsing,
 * tree encoding with git's directory sort rule, and the pack varint codecs
 * (type+size, delta-size, OFS_DELTA offset).
 *
 * Pure CPU module. The only platform import is `node:crypto` (sha1), used
 * synchronously and exposed behind Effect wrappers / a tiny incremental
 * `Sha1` interface.
 *
 * Wire-format references (verified against gitformat-pack / gitprotocol-pack):
 *
 * - Object id = sha1 over `"<type> <size>\0" + content` (uncompressed).
 * - Pack entry header: first byte `MSB | type(3) | size low 4 bits`, then
 *   little-endian 7-bit continuation groups.
 * - OFS_DELTA offset: big-endian 7-bit groups **with a +1 bias applied per
 *   continuation byte** (the classic decoder bug).
 * - Tree entries sort byte-wise by name with directories compared as if
 *   suffixed `/` (`foo.txt` < `foo/`).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Oids
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A 40-hex sha1 object id. Kept as a plain string alias in the codec layer;
 * the REST surface brands it separately.
 */
export type Oid = string;

/**
 * The all-zero oid used by the wire protocol for "no object" (ref creation
 * old-oid, ref deletion new-oid, empty-repo advertisement).
 */
export const ZERO_OID: Oid = "0".repeat(40);

/**
 * Regular expression matching a valid 40-hex sha1 oid.
 */
export const OID_REGEX = /^[0-9a-f]{40}$/;

/**
 * Returns `true` when the string is a well-formed 40-hex sha1 oid.
 */
// NOTE: deliberately NOT a type guard — `Oid` is an unbranded `string`
// alias, so `s is Oid` would narrow the else-branch to `never`.
export const isOid = (s: string): boolean => OID_REGEX.test(s);

/**
 * Error raised by the object codec when parsing malformed object content
 * (commits, trees, tags) or malformed varint/offset encodings.
 */
export class ObjectParseError extends Schema.TaggedError<ObjectParseError>()(
  "ObjectParseError",
  { reason: Schema.String },
) {}

// ─────────────────────────────────────────────────────────────────────────────
// Object types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Numeric git object types as used in pack entry headers and the object
 * store's `objects.type` column.
 */
export const ObjectType = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
} as const;

/**
 * The numeric type of a real (non-delta) git object.
 */
export type ObjectType = (typeof ObjectType)[keyof typeof ObjectType];

/**
 * Numeric pack entry types: the four object types plus the two delta
 * representations (`6 = OBJ_OFS_DELTA`, `7 = OBJ_REF_DELTA`). `0` is invalid
 * and `5` is reserved by the format.
 */
export const PackEntryType = {
  ...ObjectType,
  ofsDelta: 6,
  refDelta: 7,
} as const;

/**
 * The numeric type of a pack entry (object or delta).
 */
export type PackEntryType = (typeof PackEntryType)[keyof typeof PackEntryType];

/**
 * The canonical text name of a git object type (as used in loose headers and
 * commit/tag bodies).
 */
export type ObjectTypeName = "commit" | "tree" | "blob" | "tag";

const TYPE_NAMES: Record<ObjectType, ObjectTypeName> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

/**
 * Maps a numeric object type to its canonical text name.
 */
export const objectTypeName = (type: ObjectType): ObjectTypeName =>
  TYPE_NAMES[type];

/**
 * Maps a text object type name back to its numeric type, or `undefined` when
 * the name is not one of `commit|tree|blob|tag`.
 */
export const objectTypeOf = (name: string): ObjectType | undefined => {
  switch (name) {
    case "commit":
      return 1;
    case "tree":
      return 2;
    case "blob":
      return 3;
    case "tag":
      return 4;
    default:
      return undefined;
  }
};

/**
 * Returns `true` when a pack entry type denotes a delta (OFS or REF).
 */
export const isDeltaType = (type: PackEntryType): type is 6 | 7 =>
  type === 6 || type === 7;

// ─────────────────────────────────────────────────────────────────────────────
// Bytes / hex helpers
// ─────────────────────────────────────────────────────────────────────────────

const HEX = "0123456789abcdef";

/**
 * Lowercase hex encoding of a byte array (used for oids and pack trailers).
 */
export const bytesToHex = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  }
  return out;
};

/**
 * Decodes a lowercase/uppercase hex string into bytes. Throws
 * {@link ObjectParseError} on odd length or non-hex characters.
 */
export const hexToBytes = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) {
    throw new ObjectParseError({
      reason: `odd-length hex string: ${hex.length}`,
    });
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new ObjectParseError({
        reason: `invalid hex at position ${i * 2}`,
      });
    }
    out[i] = byte;
  }
  return out;
};

/**
 * Concatenates byte chunks into one contiguous buffer.
 */
export const concatBytes = (
  chunks: ReadonlyArray<Uint8Array>,
  totalLength?: number,
): Uint8Array => {
  const total =
    totalLength ?? chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/**
 * UTF-8 encodes a string (small shared helper for the codec modules).
 */
export const utf8Encode = (s: string): Uint8Array => encoder.encode(s);

/**
 * UTF-8 decodes bytes (lossy for non-UTF-8 content — the codec never
 * re-serializes from decoded text, so round-tripping is unaffected).
 */
export const utf8Decode = (bytes: Uint8Array): string => decoder.decode(bytes);

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal incremental sha1 hasher used for pack trailers and object ids.
 * Construct via {@link makeSha1}. `digest`/`digestHex` may be called once.
 */
export interface Sha1 {
  /** Feeds bytes into the hash. */
  readonly update: (bytes: Uint8Array) => void;
  /** Finalizes and returns the 20-byte raw digest. */
  readonly digest: () => Uint8Array;
  /** Finalizes and returns the 40-hex digest. */
  readonly digestHex: () => string;
}

/**
 * Creates an incremental sha1 hasher over `node:crypto`.
 *
 * This is a plain (synchronous, CPU-only) factory; call sites participate in
 * the Effect runtime by constructing it inside `Effect.sync` (see
 * `PackWriter`), keeping `node:crypto` contained to this module.
 */
export const makeSha1 = (): Sha1 => {
  const hash = crypto.createHash("sha1");
  let finalized: Uint8Array | undefined;
  return {
    update: (bytes) => {
      hash.update(bytes);
    },
    digest: () => {
      finalized ??= new Uint8Array(hash.digest());
      return finalized;
    },
    digestHex: () => {
      finalized ??= new Uint8Array(hash.digest());
      return bytesToHex(finalized);
    },
  };
};

/**
 * Builds the canonical loose-object header `"<type> <size>\0"` used as the
 * hashing prefix (and git's on-disk loose format prefix).
 */
export const looseHeader = (type: ObjectType, size: number): Uint8Array =>
  utf8Encode(`${objectTypeName(type)} ${size}\0`);

/**
 * Computes the object id: `sha1("<type> <size>\0" + content)` over the
 * uncompressed content.
 */
/** Synchronous form of {@link hashObject} for hot loops (DESIGN §22.5). */
export const hashObjectSync = (type: ObjectType, content: Uint8Array): Oid => {
  const sha = makeSha1();
  sha.update(looseHeader(type, content.length));
  sha.update(content);
  return sha.digestHex();
};

export const hashObject = (
  type: ObjectType,
  content: Uint8Array,
): Effect.Effect<Oid> =>
  Effect.sync(() => {
    const sha = makeSha1();
    sha.update(looseHeader(type, content.length));
    sha.update(content);
    return sha.digestHex();
  });

// ─────────────────────────────────────────────────────────────────────────────
// Commit / tag parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A parsed author/committer/tagger identity line:
 * `Name <email> <unix-ts> <±hhmm>`.
 */
export interface Identity {
  readonly name: string;
  readonly email: string;
  /** Unix timestamp in seconds. */
  readonly when: number;
  /** Timezone offset as written, e.g. `+0200` or `-0700`. */
  readonly tz: string;
}

/**
 * A parsed commit object. The raw bytes remain the source of truth for
 * hashing/round-tripping; this structure feeds the commit graph and REST
 * reads only.
 */
export interface ParsedCommit {
  /** The commit's root tree oid. */
  readonly tree: Oid;
  /** Parent commit oids, in order. */
  readonly parents: ReadonlyArray<Oid>;
  readonly author: Identity;
  readonly committer: Identity;
  /** The full GPG signature block, when present. */
  readonly gpgsig: string | undefined;
  /** Commit message (everything after the first blank line), UTF-8 decoded. */
  readonly message: string;
  /**
   * All raw headers in order as `[key, value]` pairs (continuation lines
   * joined with `\n`), including the standard ones above.
   */
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/**
 * A parsed annotated tag object.
 */
export interface ParsedTag {
  /** The tagged object's oid. */
  readonly object: Oid;
  /** The tagged object's type name. */
  readonly targetType: ObjectTypeName;
  /** The tag name (without `refs/tags/`). */
  readonly tag: string;
  /** Tagger identity; optional (ancient tags may lack it). */
  readonly tagger: Identity | undefined;
  /** Tag message. */
  readonly message: string;
  /** All raw headers in order. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

const IDENTITY_REGEX = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/;

/**
 * Parses an identity value (`Name <email> ts tz`). Fails with
 * {@link ObjectParseError} when the shape does not match.
 */
export const parseIdentity = (
  value: string,
): Effect.Effect<Identity, ObjectParseError> =>
  Effect.suspend(() => {
    const match = IDENTITY_REGEX.exec(value);
    if (match === null) {
      return Effect.fail(
        new ObjectParseError({ reason: `malformed identity: ${value}` }),
      );
    }
    return Effect.succeed({
      name: match[1]!,
      email: match[2]!,
      when: Number.parseInt(match[3]!, 10),
      tz: match[4]!,
    });
  });

/**
 * Splits an object body into its header block and message, honoring
 * continuation lines (lines starting with a single space extend the previous
 * header's value, joined with `\n` — this is how `gpgsig` spans lines).
 */
const parseHeaderBlock = (
  content: Uint8Array,
): {
  readonly headers: Array<readonly [string, string]>;
  readonly message: string;
} => {
  const text = utf8Decode(content);
  const sep = text.indexOf("\n\n");
  const headerText = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? "" : text.slice(sep + 2);
  const headers: Array<readonly [string, string]> = [];
  for (const line of headerText.split("\n")) {
    if (line.startsWith(" ") && headers.length > 0) {
      const last = headers[headers.length - 1]!;
      headers[headers.length - 1] = [last[0], `${last[1]}\n${line.slice(1)}`];
    } else {
      const space = line.indexOf(" ");
      if (space === -1) {
        headers.push([line, ""]);
      } else {
        headers.push([line.slice(0, space), line.slice(space + 1)]);
      }
    }
  }
  return { headers, message };
};

/**
 * Parses a commit object's content (without the loose header). Strict about
 * the fields the engine depends on: `tree`, `author`, `committer` must be
 * present and well-formed; unknown headers (incl. `gpgsig`) are preserved.
 */
export const parseCommit = Effect.fn(function* (content: Uint8Array) {
  const { headers, message } = parseHeaderBlock(content);
  let tree: Oid | undefined;
  const parents: Array<Oid> = [];
  let authorRaw: string | undefined;
  let committerRaw: string | undefined;
  let gpgsig: string | undefined;
  for (const [key, value] of headers) {
    switch (key) {
      case "tree":
        if (!isOid(value)) {
          return yield* new ObjectParseError({
            reason: `commit tree is not a valid oid: ${value}`,
          });
        }
        tree = value;
        break;
      case "parent":
        if (!isOid(value)) {
          return yield* new ObjectParseError({
            reason: `commit parent is not a valid oid: ${value}`,
          });
        }
        parents.push(value);
        break;
      case "author":
        authorRaw = value;
        break;
      case "committer":
        committerRaw = value;
        break;
      case "gpgsig":
        gpgsig = value;
        break;
      default:
        break;
    }
  }
  if (tree === undefined) {
    return yield* new ObjectParseError({ reason: "commit has no tree header" });
  }
  if (authorRaw === undefined) {
    return yield* new ObjectParseError({
      reason: "commit has no author header",
    });
  }
  if (committerRaw === undefined) {
    return yield* new ObjectParseError({
      reason: "commit has no committer header",
    });
  }
  const author = yield* parseIdentity(authorRaw);
  const committer = yield* parseIdentity(committerRaw);
  const parsed: ParsedCommit = {
    tree,
    parents,
    author,
    committer,
    gpgsig,
    message,
    headers,
  };
  return parsed;
});

/**
 * Formats an identity line value: `Name <email> <unix-ts> <±hhmm>`.
 * Round-trips {@link parseIdentity}.
 */
export const formatIdentity = (id: Identity): string =>
  `${id.name} <${id.email}> ${id.when} ${id.tz}`;

/** Input of {@link encodeCommit}. */
export interface CommitFields {
  /** The commit's root tree oid. */
  readonly tree: Oid;
  /** Parent commit oids, in order. */
  readonly parents: ReadonlyArray<Oid>;
  readonly author: Identity;
  readonly committer: Identity;
  /** Message, verbatim — callers include the trailing `\n`. */
  readonly message: string;
}

const TZ_REGEX = /^[+-]\d{4}$/;

const validateIdentity = (
  role: string,
  id: Identity,
): ObjectParseError | undefined => {
  if (/[<>\n]/.test(id.name) || /[<>\n]/.test(id.email)) {
    return new ObjectParseError({
      reason: `commit ${role} name/email must not contain '<', '>' or newline`,
    });
  }
  if (!Number.isInteger(id.when) || id.when < 0) {
    return new ObjectParseError({
      reason: `commit ${role} timestamp is not a non-negative integer: ${id.when}`,
    });
  }
  if (!TZ_REGEX.test(id.tz)) {
    return new ObjectParseError({
      reason: `commit ${role} timezone is not ±hhmm: ${id.tz}`,
    });
  }
  return undefined;
};

/**
 * Encodes commit content (without the loose header):
 * `tree <oid>\n` + `parent <oid>\n`* + `author …\n` + `committer …\n` +
 * `\n` + message. Byte-exact round trip through {@link parseCommit}.
 */
export const encodeCommit = (
  fields: CommitFields,
): Effect.Effect<Uint8Array, ObjectParseError> =>
  Effect.suspend(() => {
    if (!isOid(fields.tree)) {
      return Effect.fail(
        new ObjectParseError({
          reason: `commit tree is not a valid oid: ${fields.tree}`,
        }),
      );
    }
    for (const parent of fields.parents) {
      if (!isOid(parent)) {
        return Effect.fail(
          new ObjectParseError({
            reason: `commit parent is not a valid oid: ${parent}`,
          }),
        );
      }
    }
    for (const [role, id] of [
      ["author", fields.author],
      ["committer", fields.committer],
    ] as const) {
      const invalid = validateIdentity(role, id);
      if (invalid !== undefined) return Effect.fail(invalid);
    }
    const lines = [
      `tree ${fields.tree}\n`,
      ...fields.parents.map((parent) => `parent ${parent}\n`),
      `author ${formatIdentity(fields.author)}\n`,
      `committer ${formatIdentity(fields.committer)}\n`,
      `\n`,
      fields.message,
    ];
    return Effect.succeed(utf8Encode(lines.join("")));
  });

/**
 * Parses an annotated tag object's content (without the loose header).
 * `object`, `type`, and `tag` are required; `tagger` is optional.
 */
export const parseTag = Effect.fn(function* (content: Uint8Array) {
  const { headers, message } = parseHeaderBlock(content);
  let object: Oid | undefined;
  let targetType: ObjectTypeName | undefined;
  let tag: string | undefined;
  let taggerRaw: string | undefined;
  for (const [key, value] of headers) {
    switch (key) {
      case "object":
        if (!isOid(value)) {
          return yield* new ObjectParseError({
            reason: `tag object is not a valid oid: ${value}`,
          });
        }
        object = value;
        break;
      case "type": {
        const t = objectTypeOf(value);
        if (t === undefined) {
          return yield* new ObjectParseError({
            reason: `tag has invalid target type: ${value}`,
          });
        }
        targetType = objectTypeName(t);
        break;
      }
      case "tag":
        tag = value;
        break;
      case "tagger":
        taggerRaw = value;
        break;
      default:
        break;
    }
  }
  if (object === undefined || targetType === undefined || tag === undefined) {
    return yield* new ObjectParseError({
      reason: "tag is missing object/type/tag header",
    });
  }
  const tagger =
    taggerRaw === undefined ? undefined : yield* parseIdentity(taggerRaw);
  const parsed: ParsedTag = {
    object,
    targetType,
    tag,
    tagger,
    message,
    headers,
  };
  return parsed;
});

// ─────────────────────────────────────────────────────────────────────────────
// Trees
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One entry of a tree object.
 *
 * `mode` is the ascii octal mode without leading zeros as stored in canonical
 * trees: `100644` file, `100755` executable, `120000` symlink, `160000`
 * gitlink (submodule), `40000` subtree.
 */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: Oid;
}

/** Tree mode string for a subtree entry. */
export const TREE_MODE = "40000";
/** Tree mode string for a gitlink (submodule) entry. */
export const GITLINK_MODE = "160000";

/**
 * The high-level kind of a tree entry derived from its mode.
 */
export type TreeEntryKind = "blob" | "tree" | "commit";

/**
 * Classifies a tree entry mode: `40000` → `tree`, `160000` → `commit`
 * (gitlink), anything else → `blob`.
 */
export const treeEntryKind = (mode: string): TreeEntryKind =>
  mode === TREE_MODE ? "tree" : mode === GITLINK_MODE ? "commit" : "blob";

/**
 * Parses a tree object's content into its entries:
 * `<mode ascii octal> SP <name> NUL <20 raw sha1 bytes>` concatenated with no
 * separators.
 */
export const parseTree = (
  content: Uint8Array,
): Effect.Effect<ReadonlyArray<TreeEntry>, ObjectParseError> =>
  Effect.suspend(() => {
    const entries: Array<TreeEntry> = [];
    let pos = 0;
    while (pos < content.length) {
      const spaceIdx = content.indexOf(0x20, pos);
      if (spaceIdx === -1) {
        return Effect.fail(
          new ObjectParseError({
            reason: `tree entry at ${pos}: no space after mode`,
          }),
        );
      }
      const mode = utf8Decode(content.subarray(pos, spaceIdx));
      if (!/^[0-7]{1,6}$/.test(mode)) {
        return Effect.fail(
          new ObjectParseError({
            reason: `tree entry at ${pos}: bad mode ${mode}`,
          }),
        );
      }
      const nulIdx = content.indexOf(0x00, spaceIdx + 1);
      if (nulIdx === -1) {
        return Effect.fail(
          new ObjectParseError({
            reason: `tree entry at ${pos}: no NUL after name`,
          }),
        );
      }
      const name = utf8Decode(content.subarray(spaceIdx + 1, nulIdx));
      if (name.length === 0) {
        return Effect.fail(
          new ObjectParseError({ reason: `tree entry at ${pos}: empty name` }),
        );
      }
      if (nulIdx + 21 > content.length) {
        return Effect.fail(
          new ObjectParseError({
            reason: `tree entry at ${pos}: truncated sha`,
          }),
        );
      }
      const oid = bytesToHex(content.subarray(nulIdx + 1, nulIdx + 21));
      entries.push({ mode, name, oid });
      pos = nulIdx + 21;
    }
    return Effect.succeed(entries);
  });

/**
 * Compares two tree entries with git's canonical sort rule: byte-wise on the
 * name **with directory entries compared as if suffixed `/`** (so `foo.txt`
 * sorts before the tree `foo`, which sorts as `foo/`). Wrong order changes
 * the tree hash and trips `git fsck`.
 */
export const treeEntryCompare = (a: TreeEntry, b: TreeEntry): number => {
  const aBytes = utf8Encode(
    treeEntryKind(a.mode) === "tree" ? `${a.name}/` : a.name,
  );
  const bBytes = utf8Encode(
    treeEntryKind(b.mode) === "tree" ? `${b.name}/` : b.name,
  );
  const len = Math.min(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    const d = aBytes[i]! - bBytes[i]!;
    if (d !== 0) return d;
  }
  return aBytes.length - bBytes.length;
};

/**
 * Encodes tree entries into canonical tree object content. Entries are sorted
 * with {@link treeEntryCompare} and modes are normalized (leading zeros
 * stripped, so `040000` becomes the canonical `40000`).
 */
export const encodeTree = (
  entries: ReadonlyArray<TreeEntry>,
): Effect.Effect<Uint8Array, ObjectParseError> =>
  Effect.suspend(() => {
    try {
      const sorted = [...entries].sort(treeEntryCompare);
      const parts: Array<Uint8Array> = [];
      let total = 0;
      for (const entry of sorted) {
        const mode = entry.mode.replace(/^0+(?=\d)/, "");
        if (!/^[0-7]{1,6}$/.test(mode)) {
          throw new ObjectParseError({
            reason: `invalid tree entry mode: ${entry.mode}`,
          });
        }
        if (!isOid(entry.oid)) {
          throw new ObjectParseError({
            reason: `invalid tree entry oid: ${entry.oid}`,
          });
        }
        const head = utf8Encode(`${mode} ${entry.name}\0`);
        const sha = hexToBytes(entry.oid);
        parts.push(head, sha);
        total += head.length + sha.length;
      }
      return Effect.succeed(concatBytes(parts, total));
    } catch (error) {
      return error instanceof ObjectParseError
        ? Effect.fail(error)
        : Effect.fail(new ObjectParseError({ reason: String(error) }));
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Varint codecs (pack format)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of decoding a pack entry type+size header.
 */
export interface TypeSizeHeader {
  readonly type: PackEntryType;
  /** Uncompressed size of the entry data (for deltas: of the delta payload). */
  readonly size: number;
  /** Offset of the first byte after the header. */
  readonly next: number;
}

/**
 * Decodes the pack entry header varint at `offset`:
 * `size = (b0 & 0x0F) | (b1 & 0x7F) << 4 | (b2 & 0x7F) << 11 | ...`,
 * `type = (b0 >> 4) & 0x07`. Throws {@link ObjectParseError} on truncation
 * or an invalid type (0 or 5).
 */
export const decodeTypeSize = (
  buf: Uint8Array,
  offset: number,
): TypeSizeHeader => {
  if (offset >= buf.length) {
    throw new ObjectParseError({ reason: "truncated pack entry header" });
  }
  let b = buf[offset]!;
  const rawType = (b >> 4) & 0x07;
  if (rawType === 0 || rawType === 5) {
    throw new ObjectParseError({
      reason: `invalid pack entry type ${rawType} at offset ${offset}`,
    });
  }
  const type = rawType as PackEntryType;
  let size = b & 0x0f;
  let shift = 4;
  let i = offset + 1;
  while ((b & 0x80) !== 0) {
    if (i >= buf.length) {
      throw new ObjectParseError({ reason: "truncated pack entry header" });
    }
    if (shift > 53) {
      throw new ObjectParseError({ reason: "pack entry size varint overflow" });
    }
    b = buf[i]!;
    i += 1;
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { type, size, next: i };
};

/**
 * Encodes a pack entry type+size header varint (inverse of
 * {@link decodeTypeSize}).
 */
export const encodeTypeSize = (
  type: PackEntryType,
  size: number,
): Uint8Array => {
  const out: Array<number> = [];
  let rest = Math.floor(size / 16);
  let first = ((type & 0x07) << 4) | (size & 0x0f);
  if (rest > 0) first |= 0x80;
  out.push(first);
  while (rest > 0) {
    let b = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) b |= 0x80;
    out.push(b);
  }
  return Uint8Array.from(out);
};

/**
 * Result of decoding a plain little-endian 7-bit varint.
 */
export interface Varint {
  readonly value: number;
  /** Offset of the first byte after the varint. */
  readonly next: number;
}

/**
 * Decodes a plain little-endian 7-bit varint (MSB = continue) — the encoding
 * used by delta payload base/result size headers. Throws
 * {@link ObjectParseError} on truncation or overflow past 2^53.
 */
export const decodeSizeVarint = (buf: Uint8Array, offset: number): Varint => {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= buf.length) {
      throw new ObjectParseError({ reason: "truncated size varint" });
    }
    if (shift > 53) {
      throw new ObjectParseError({ reason: "size varint overflow" });
    }
    const b = buf[i]!;
    i += 1;
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
};

/**
 * Encodes a plain little-endian 7-bit varint (inverse of
 * {@link decodeSizeVarint}).
 */
export const encodeSizeVarint = (value: number): Uint8Array => {
  const out: Array<number> = [];
  let v = value;
  for (;;) {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
    if (v === 0) break;
  }
  return Uint8Array.from(out);
};

/**
 * Decodes an OFS_DELTA negative-offset varint at `offset`: big-endian 7-bit
 * groups (MSB = continue) **with a +1 bias applied on every continuation**:
 *
 * ```
 * n = b0 & 0x7F
 * while (b0 & 0x80): b0 = next; n = ((n + 1) << 7) | (b0 & 0x7F)
 * ```
 *
 * Naive concatenation without the `+1` is wrong for multi-byte offsets.
 * Throws {@link ObjectParseError} on truncation.
 */
export const decodeOfsDeltaOffset = (
  buf: Uint8Array,
  offset: number,
): Varint => {
  if (offset >= buf.length) {
    throw new ObjectParseError({ reason: "truncated ofs-delta offset" });
  }
  let i = offset;
  let b = buf[i]!;
  i += 1;
  let n = b & 0x7f;
  while ((b & 0x80) !== 0) {
    if (i >= buf.length) {
      throw new ObjectParseError({ reason: "truncated ofs-delta offset" });
    }
    b = buf[i]!;
    i += 1;
    n = (n + 1) * 128 + (b & 0x7f);
    if (!Number.isSafeInteger(n)) {
      throw new ObjectParseError({ reason: "ofs-delta offset overflow" });
    }
  }
  return { value: n, next: i };
};

/**
 * Encodes an OFS_DELTA negative-offset varint (inverse of
 * {@link decodeOfsDeltaOffset}, matching git's encoder: subtract the bias per
 * continuation byte, big-endian order).
 */
export const encodeOfsDeltaOffset = (value: number): Uint8Array => {
  const out: Array<number> = [value & 0x7f];
  let v = Math.floor(value / 128);
  while (v > 0) {
    v -= 1;
    out.unshift(0x80 | (v & 0x7f));
    v = Math.floor(v / 128);
  }
  return Uint8Array.from(out);
};
