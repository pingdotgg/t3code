/**
 * Scans pack entries out of a BUFFER that starts at an entry boundary and
 * may end mid-entry (DESIGN §22.7): the unit of work a hashing Worker
 * receives from the receive-pack pipeline — one spilled part plus the
 * carry-over of the previous part's incomplete tail.
 *
 * Everything that can be settled inside the buffer is settled here:
 * non-delta entries are inflated and hashed (the expensive part of
 * ingest), OFS/REF deltas whose base is in the same buffer are applied,
 * re-deflated and hashed. Deltas whose base lies outside the buffer are
 * reported as `unresolved` with what the caller needs to settle them
 * later. The scan stops at the first entry that does not fit; `consumedTo`
 * is the absolute offset where it starts, so the caller can carry the tail.
 * An entry only counts as fitting when the buffer extends at least one byte
 * past it, so the buffer must always end with what FOLLOWS the last entry
 * to consume (the next part's bytes, or the pack trailer).
 *
 * Pure: no store, no I/O. The trailer is NOT verified here (the caller
 * hashes the whole pack as it streams).
 */
import * as Effect from "effect/Effect";
import { applyDelta } from "./Delta.ts";
import {
  bytesToHex,
  decodeOfsDeltaOffset,
  decodeTypeSize,
  hashObjectSync,
  ObjectParseError,
  type ObjectType,
  type Oid,
} from "./ObjectCodec.ts";
import {
  deflate,
  inflate,
  inflateEntrySync,
  inflateExactSpan,
  type InflatedEntry,
} from "./Zlib.ts";
import { ObjectTooLargeError, PackFormatError } from "./PackParser.ts";

export interface ScannedEntry {
  readonly oid: Oid;
  readonly type: ObjectType;
  /** Absolute pack offset of the entry HEADER (what OFS_DELTAs point at). */
  readonly offset: number;
  /** Uncompressed size. */
  readonly size: number;
  /** Absolute pack offset of the entry's zdata (its header precedes it). */
  readonly dataOffset: number;
  /** Compressed span at `dataOffset` — verbatim for non-delta entries. */
  readonly span: number;
  /** Set for delta-resolved entries: a fresh deflate to store as the row. */
  readonly zdata?: Uint8Array | undefined;
  /** Inflated content for commits, trees and tags (the store parses them). */
  readonly content?: Uint8Array | undefined;
  /**
   * For a delta-resolved entry, its base reference — so a hasher that must
   * bound its response can demote the entry back to `unresolved`.
   */
  readonly baseOffset?: number | undefined;
  readonly baseOid?: Oid | undefined;
}

export interface UnresolvedDelta {
  /** Absolute pack offset of the entry header. */
  readonly offset: number;
  /** Absolute offset of the delta payload's zdata and its span. */
  readonly dataOffset: number;
  readonly span: number;
  /** The base: an absolute pack offset (OFS_DELTA) or an oid (REF_DELTA). */
  readonly baseOffset?: number | undefined;
  readonly baseOid?: Oid | undefined;
  /** Declared (uncompressed) size of the delta payload. */
  readonly size: number;
}

export interface ScanResult {
  /** Absolute offset of the first entry scanned (after resync), or -1 if none. */
  readonly firstOffset: number;
  readonly entries: ReadonlyArray<ScannedEntry>;
  readonly unresolved: ReadonlyArray<UnresolvedDelta>;
  /** Absolute offset of the first entry NOT consumed (carry from here). */
  readonly consumedTo: number;
  /** Entries consumed (resolved + unresolved). */
  readonly count: number;
}

const isDelta = (type: number) => type === 6 || type === 7;

/**
 * Scans `buf`, whose byte 0 is at absolute pack offset `base`. `remaining`
 * is how many entries the pack still owes (so a trailing partial entry
 * beyond the count is not mistaken for data); `maxObjectSize` bounds
 * inflated sizes.
 */
export const scanPart = (
  buf: Uint8Array,
  options: {
    readonly base: number;
    readonly remaining: number;
    readonly maxObjectSize: number;
    /** Resolved content LRU budget for in-buffer delta bases. */
    readonly cacheBytes?: number | undefined;
    /**
     * `buf` does NOT necessarily start at an entry boundary (a raw chunk of
     * a pack, DESIGN §22.9): find the first boundary with {@link findBoundary}
     * and scan from there. No boundary within the chunk ⇒ no entries.
     */
    readonly resync?: boolean | undefined;
  },
): Effect.Effect<ScanResult, PackFormatError | ObjectTooLargeError> =>
  Effect.gen(function* () {
    const entries: Array<ScannedEntry> = [];
    const unresolved: Array<UnresolvedDelta> = [];
    let firstOffset = -1;
    let startAt = 0;
    if (options.resync === true) {
      const found = findBoundary(buf, { maxObjectSize: options.maxObjectSize });
      if (found === undefined) {
        return {
          firstOffset: -1,
          entries,
          unresolved,
          consumedTo: options.base,
          count: 0,
        };
      }
      startAt = found;
      firstOffset = options.base + found;
    }
    // In resync mode `remaining` is only an upper bound and the buffer may
    // run into the pack trailer: anything that does not parse as an entry
    // ends the scan instead of failing it (the pipeline validates the count,
    // the trailer hash and every object id downstream).
    const lenient = options.resync === true;
    // Content of resolved entries in this buffer, by absolute offset and by
    // oid, for in-buffer delta bases. Bounded; a miss becomes unresolved.
    const byOffset = new Map<
      number,
      { type: ObjectType; content: Uint8Array }
    >();
    const byOid = new Map<string, { type: ObjectType; content: Uint8Array }>();
    let cached = 0;
    const budget = options.cacheBytes ?? 20 * 1024 * 1024;
    const remember = (
      offset: number,
      oid: Oid,
      type: ObjectType,
      content: Uint8Array,
    ) => {
      if (content.length > budget / 4) return;
      while (cached + content.length > budget && byOffset.size > 0) {
        const oldest = byOffset.keys().next().value!;
        const dropped = byOffset.get(oldest)!;
        byOffset.delete(oldest);
        cached -= dropped.content.length;
      }
      byOffset.set(offset, { type, content });
      byOid.set(oid, { type, content });
      cached += content.length;
    };

    let pos = startAt;
    let count = 0;
    while (count < options.remaining && pos < buf.length) {
      const offset = options.base + pos;
      let header;
      try {
        header = decodeTypeSize(buf, pos);
      } catch (error) {
        // A header cut by the buffer edge: stop here, carry the tail.
        if (lenient || buf.length - pos < 16) break;
        return yield* new PackFormatError({
          reason:
            error instanceof ObjectParseError
              ? `entry at ${offset}: ${error.reason}`
              : `entry at ${offset}: ${String(error)}`,
        });
      }
      if (header.size > options.maxObjectSize) {
        if (lenient) break;
        return yield* new ObjectTooLargeError({
          size: header.size,
          limit: options.maxObjectSize,
        });
      }
      let at = header.next;
      let baseOffset: number | undefined;
      let baseOid: Oid | undefined;
      if (header.type === 6) {
        let ofs;
        try {
          ofs = decodeOfsDeltaOffset(buf, at);
        } catch {
          if (lenient || buf.length - at < 16) break;
          return yield* new PackFormatError({
            reason: `entry at ${offset}: bad ofs-delta`,
          });
        }
        at = ofs.next;
        baseOffset = offset - ofs.value;
      } else if (header.type === 7) {
        if (at + 20 > buf.length) break;
        baseOid = bytesToHex(buf.subarray(at, at + 20)) as Oid;
        at += 20;
      }
      const inflated: InflatedEntry | undefined = inflateEntrySync(buf, at, {
        maxOutput: options.maxObjectSize,
        expectedSize: header.size,
      });
      if (inflated === undefined) {
        // The compressed stream runs past the buffer (or is corrupt — the
        // next attempt, with more bytes, decides): carry from this entry.
        break;
      }
      const { bytesConsumed, content: payload } = inflated;
      // A stream cut inside its last bytes (end-of-block bits, adler32) can
      // inflate to exactly the declared size without having ended, and the
      // consumed count would then be short. An entry is complete only when
      // the buffer extends PAST it: callers always append what follows
      // (the next part, or the pack trailer for the last one).
      if (at + bytesConsumed >= buf.length) break;
      if (payload.length !== header.size) {
        if (lenient) break;
        return yield* new PackFormatError({
          reason: `entry at ${offset}: inflated ${payload.length} bytes, header declared ${header.size}`,
        });
      }
      const dataOffset = options.base + at;
      if (!isDelta(header.type)) {
        const type = header.type as ObjectType;
        const oid = hashObjectSync(type, payload);
        entries.push({
          oid,
          type,
          offset,
          size: payload.length,
          dataOffset,
          span: bytesConsumed,
          content: type === 3 ? undefined : payload,
        });
        remember(offset, oid, type, payload);
      } else {
        const found =
          baseOffset !== undefined
            ? byOffset.get(baseOffset)
            : byOid.get(baseOid!);
        if (found === undefined) {
          unresolved.push({
            offset,
            dataOffset,
            span: bytesConsumed,
            baseOffset,
            baseOid,
            size: header.size,
          });
        } else {
          const content = yield* applyDelta(found.content, payload).pipe(
            Effect.mapError(
              (error) =>
                new PackFormatError({
                  reason: `entry at ${offset}: ${error.reason}`,
                }),
            ),
          );
          if (content.length > options.maxObjectSize) {
            return yield* new ObjectTooLargeError({
              size: content.length,
              limit: options.maxObjectSize,
            });
          }
          const oid = hashObjectSync(found.type, content);
          const zdata = yield* deflate(content).pipe(
            Effect.mapError(
              (error) => new PackFormatError({ reason: error.reason }),
            ),
          );
          entries.push({
            oid,
            type: found.type,
            offset,
            size: content.length,
            dataOffset,
            span: bytesConsumed,
            zdata,
            content: found.type === 3 ? undefined : content,
            baseOffset,
            baseOid,
          });
          remember(offset, oid, found.type, content);
        }
      }
      pos = at + bytesConsumed;
      count += 1;
    }
    return {
      firstOffset:
        firstOffset >= 0 ? firstOffset : entries.length > 0 ? options.base : -1,
      entries,
      unresolved,
      consumedTo: options.base + pos,
      count,
    };
  });

/** One entry's coordinates from a boundary-only scan (DESIGN §22.8). */
export interface EntryBounds {
  /** Absolute pack offset of the entry header. */
  readonly offset: number;
  /** 1–4 for full objects, 6/7 for OFS/REF deltas. */
  readonly type: number;
  /** Declared (uncompressed) size. */
  readonly size: number;
  /** Absolute offset and length of the compressed span. */
  readonly dataOffset: number;
  readonly span: number;
  readonly baseOffset?: number | undefined;
  readonly baseOid?: Oid | undefined;
}

export interface BoundsResult {
  readonly entries: ReadonlyArray<EntryBounds>;
  /** Absolute offset of the first entry NOT consumed (carry from here). */
  readonly consumedTo: number;
}

/**
 * Boundary-only scan (DESIGN §22.8): finds every entry's compressed span in
 * `buf` without hashing or resolving anything — the one inherently
 * sequential step of pack ingest (a stream's end is only known by inflating
 * it). With spans known, hashing every part can run in parallel and can
 * inflate exact slices with the cheap one-shot path. Same contract as
 * {@link scanPart}: `buf` starts at an entry boundary and must extend past
 * the last entry to consume.
 */
export const scanBounds = (
  buf: Uint8Array,
  options: {
    readonly base: number;
    readonly remaining: number;
    readonly maxObjectSize: number;
  },
): Effect.Effect<BoundsResult, PackFormatError | ObjectTooLargeError> =>
  Effect.gen(function* () {
    const entries: Array<EntryBounds> = [];
    let pos = 0;
    let count = 0;
    while (count < options.remaining && pos < buf.length) {
      const offset = options.base + pos;
      let header;
      try {
        header = decodeTypeSize(buf, pos);
      } catch (error) {
        if (buf.length - pos < 16) break;
        return yield* new PackFormatError({
          reason:
            error instanceof ObjectParseError
              ? `entry at ${offset}: ${error.reason}`
              : `entry at ${offset}: ${String(error)}`,
        });
      }
      if (header.size > options.maxObjectSize) {
        return yield* new ObjectTooLargeError({
          size: header.size,
          limit: options.maxObjectSize,
        });
      }
      let at = header.next;
      let baseOffset: number | undefined;
      let baseOid: Oid | undefined;
      if (header.type === 6) {
        let ofs;
        try {
          ofs = decodeOfsDeltaOffset(buf, at);
        } catch {
          if (buf.length - at < 16) break;
          return yield* new PackFormatError({
            reason: `entry at ${offset}: bad ofs-delta`,
          });
        }
        at = ofs.next;
        baseOffset = offset - ofs.value;
      } else if (header.type === 7) {
        if (at + 20 > buf.length) break;
        baseOid = bytesToHex(buf.subarray(at, at + 20)) as Oid;
        at += 20;
      }
      const inflated = inflateEntrySync(buf, at, {
        maxOutput: options.maxObjectSize,
        expectedSize: header.size,
      });
      if (inflated === undefined) break;
      if (at + inflated.bytesConsumed >= buf.length) break;
      if (inflated.content.length !== header.size) {
        return yield* new PackFormatError({
          reason: `entry at ${offset}: inflated ${inflated.content.length} bytes, header declared ${header.size}`,
        });
      }
      entries.push({
        offset,
        type: header.type,
        size: header.size,
        dataOffset: options.base + at,
        span: inflated.bytesConsumed,
        baseOffset,
        baseOid,
      });
      pos = at + inflated.bytesConsumed;
      count += 1;
    }
    return { entries, consumedTo: options.base + pos };
  });

/**
 * Hashes entries whose spans are already known (DESIGN §22.8): the parallel
 * half. `bounds` addresses spans inside `buf` (absolute offsets; `base` is
 * `buf[0]`'s offset). Non-delta entries are inflated with the one-shot
 * path and hashed; deltas whose base is among these entries (or already
 * resolved here) are applied, re-deflated and hashed; the rest are reported
 * unresolved.
 */
export const hashBounds = (
  buf: Uint8Array,
  bounds: ReadonlyArray<EntryBounds>,
  options: {
    readonly base: number;
    readonly maxObjectSize: number;
    readonly cacheBytes?: number | undefined;
  },
): Effect.Effect<ScanResult, PackFormatError | ObjectTooLargeError> =>
  Effect.gen(function* () {
    const entries: Array<ScannedEntry> = [];
    const unresolved: Array<UnresolvedDelta> = [];
    const byOffset = new Map<
      number,
      { type: ObjectType; content: Uint8Array }
    >();
    const byOid = new Map<string, { type: ObjectType; content: Uint8Array }>();
    const inflateExact = (b: EntryBounds) =>
      inflateExactSpan(
        buf.subarray(
          b.dataOffset - options.base,
          b.dataOffset - options.base + b.span,
        ),
        b.size,
      ).pipe(
        Effect.mapError(
          (error) =>
            new PackFormatError({
              reason: `entry at ${b.offset}: ${error.reason}`,
            }),
        ),
      );
    for (const b of bounds) {
      const payload = yield* inflateExact(b);
      if (!isDelta(b.type)) {
        const type = b.type as ObjectType;
        const oid = hashObjectSync(type, payload);
        entries.push({
          oid,
          type,
          offset: b.offset,
          size: payload.length,
          dataOffset: b.dataOffset,
          span: b.span,
          content: type === 3 ? undefined : payload,
        });
        byOffset.set(b.offset, { type, content: payload });
        byOid.set(oid, { type, content: payload });
        continue;
      }
      const found =
        b.baseOffset !== undefined
          ? byOffset.get(b.baseOffset)
          : byOid.get(b.baseOid!);
      if (found === undefined) {
        unresolved.push({
          offset: b.offset,
          dataOffset: b.dataOffset,
          span: b.span,
          baseOffset: b.baseOffset,
          baseOid: b.baseOid,
          size: b.size,
        });
        continue;
      }
      const content = yield* applyDelta(found.content, payload).pipe(
        Effect.mapError(
          (error) =>
            new PackFormatError({
              reason: `entry at ${b.offset}: ${error.reason}`,
            }),
        ),
      );
      if (content.length > options.maxObjectSize) {
        return yield* new ObjectTooLargeError({
          size: content.length,
          limit: options.maxObjectSize,
        });
      }
      const oid = hashObjectSync(found.type, content);
      const zdata = yield* deflate(content).pipe(
        Effect.mapError(
          (error) => new PackFormatError({ reason: error.reason }),
        ),
      );
      entries.push({
        oid,
        type: found.type,
        offset: b.offset,
        size: content.length,
        dataOffset: b.dataOffset,
        span: b.span,
        zdata,
        content: found.type === 3 ? undefined : content,
      });
      byOffset.set(b.offset, { type: found.type, content });
      byOid.set(oid, { type: found.type, content });
    }
    const last = bounds[bounds.length - 1];
    return {
      firstOffset: bounds[0]?.offset ?? -1,
      entries,
      unresolved,
      consumedTo:
        last === undefined ? options.base : last.dataOffset + last.span,
      count: bounds.length,
    };
  });

/**
 * Finds the first entry boundary inside `buf` (DESIGN §22.9): the parallel
 * answer to "where does an entry start?", so chunks of a pack can be scanned
 * independently. A position is a boundary when it decodes as an entry
 * header, its stream inflates to exactly the declared size, AND the entry
 * that follows does too — two consecutive coincidences on arbitrary bytes
 * are not a realistic false positive, and the pack trailer plus per-object
 * hashing verify everything downstream regardless.
 *
 * Candidates are filtered cheaply: a deflate stream from git starts with
 * the zlib header `0x78` followed by one of four FLG bytes, right after a
 * 1–10 byte varint header. Returns the offset into `buf`, or `undefined`
 * when no boundary lies within `maxSearch` bytes — the whole chunk by
 * default: a part whose head is inside one large entry still has its own
 * entries to hash, and a part that reports no boundary is hashed serially
 * as a region by the caller (a 10 MB blob spanning three parts once cost
 * a whole part's worth of serial hashing under a 1 MiB limit).
 */
export const findBoundary = (
  buf: Uint8Array,
  options: {
    readonly maxObjectSize: number;
    readonly maxSearch?: number | undefined;
  },
): number | undefined => {
  const limit = Math.min(buf.length, options.maxSearch ?? buf.length);
  const isZlibHeader = (i: number) =>
    i + 1 < buf.length &&
    buf[i] === 0x78 &&
    (buf[i + 1] === 0x01 ||
      buf[i + 1] === 0x5e ||
      buf[i + 1] === 0x9c ||
      buf[i + 1] === 0xda);
  const parses = (pos: number): number | undefined => {
    let header;
    try {
      header = decodeTypeSize(buf, pos);
    } catch {
      return undefined;
    }
    if (header.type < 1 || header.type > 7) return undefined;
    if (header.size > options.maxObjectSize) return undefined;
    let at = header.next;
    if (header.type === 6) {
      try {
        at = decodeOfsDeltaOffset(buf, at).next;
      } catch {
        return undefined;
      }
    } else if (header.type === 7) {
      at += 20;
    }
    if (!isZlibHeader(at)) return undefined;
    const inflated = inflateEntrySync(buf, at, {
      maxOutput: options.maxObjectSize,
      expectedSize: header.size,
    });
    if (inflated === undefined || inflated.content.length !== header.size)
      return undefined;
    const end = at + inflated.bytesConsumed;
    return end >= buf.length ? undefined : end;
  };
  for (let pos = 0; pos < limit; pos++) {
    // Cheap pre-filter: a zlib header must appear within the next 32 bytes
    // (header varint + optional base ref).
    let plausible = false;
    for (let k = pos + 1; k <= pos + 32 && k < buf.length; k++) {
      if (isZlibHeader(k)) {
        plausible = true;
        break;
      }
    }
    if (!plausible) continue;
    const next = parses(pos);
    if (next === undefined) continue;
    // Second entry must parse too (or the buffer ends right after — accept
    // only if the first entry ended cleanly inside the buffer).
    const after = parses(next);
    if (after !== undefined) return pos;
  }
  return undefined;
};

// ── delta resolution as a job (DESIGN §22.13) ──────────────────────────────

/** One base a batch of delta jobs refers to: zlib bytes, or already-inflated content. */
export interface DeltaBase {
  readonly bytes: Uint8Array;
  readonly isContent: boolean;
}

/** One delta to apply: its base (by index into the batch's bases) and its zlib bytes. */
export interface DeltaJob {
  readonly id: number;
  readonly type: ObjectType;
  readonly base: number;
  readonly delta: Uint8Array;
}

/** A resolved delta: the object's oid and a fresh deflate; content for non-blobs. */
export interface DeltaResolved {
  readonly id: number;
  readonly oid: Oid;
  readonly size: number;
  readonly zdata: Uint8Array;
  readonly content?: Uint8Array | undefined;
}

/**
 * Applies a batch of deltas whose bases the caller supplies — the work the
 * receiver would otherwise do itself for every delta whose base lies in
 * another chunk. Pure over its inputs, so a hasher isolate can run it.
 */
export const resolveDeltas = (
  bases: ReadonlyArray<DeltaBase>,
  jobs: ReadonlyArray<DeltaJob>,
  options: { readonly maxObjectSize: number },
): Effect.Effect<Array<DeltaResolved>, PackFormatError | ObjectTooLargeError> =>
  Effect.gen(function* () {
    const inflated = new Map<number, Uint8Array>();
    const baseContent = (index: number) =>
      Effect.gen(function* () {
        const cached = inflated.get(index);
        if (cached !== undefined) return cached;
        const base = bases[index];
        if (base === undefined) {
          return yield* new PackFormatError({
            reason: `delta base ${index} missing`,
          });
        }
        const content = base.isContent
          ? base.bytes
          : yield* inflate(base.bytes).pipe(
              Effect.mapError(
                (error) => new PackFormatError({ reason: error.reason }),
              ),
            );
        inflated.set(index, content);
        return content;
      });
    const out: Array<DeltaResolved> = [];
    for (const job of jobs) {
      const base = yield* baseContent(job.base);
      const delta = yield* inflate(job.delta).pipe(
        Effect.mapError(
          (error) => new PackFormatError({ reason: error.reason }),
        ),
      );
      const content = yield* applyDelta(base, delta).pipe(
        Effect.mapError(
          (error) => new PackFormatError({ reason: error.reason }),
        ),
      );
      if (content.length > options.maxObjectSize) {
        return yield* new ObjectTooLargeError({
          size: content.length,
          limit: options.maxObjectSize,
        });
      }
      const oid = hashObjectSync(job.type, content);
      const zdata = yield* deflate(content).pipe(
        Effect.mapError(
          (error) => new PackFormatError({ reason: error.reason }),
        ),
      );
      out.push({
        id: job.id,
        oid,
        size: content.length,
        zdata,
        content: job.type === 3 ? undefined : content,
      });
    }
    return out;
  });
