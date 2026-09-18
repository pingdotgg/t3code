/**
 * Pack ingestion (DESIGN §3.6): a single pass over a pack held behind a
 * {@link RandomAccess} source, under the push semaphore.
 *
 * 1. Validate `PACK`, version 2, count.
 * 2. Per entry: parse the type/size varint header. Non-delta entries are
 *    streaming-inflated (`Zlib.inflateEntry` — `bytesWritten` gives the exact
 *    compressed span), hashed as `sha1("<type> <size>\0" + content)`, and the
 *    **compressed span is kept verbatim as `zdata`** — no recompression.
 *    Deltas (OFS with the +1-bias offset decoding, REF with a 20-byte base
 *    id) resolve their base from (a) already-ingested entries via a bounded
 *    LRU of resolved contents, (b) re-inflation from the pack on cache miss,
 *    or (c) the object store for thin bases (REF_DELTA to a prior push — the
 *    normal case). The copy/insert instruction stream is applied
 *    (`size==0 ⇒ 0x10000`), the result size verified, the result hashed and
 *    `deflate`d (level 6) for storage.
 * 3. The trailing pack SHA-1 is verified.
 *
 * Resolved entries are emitted to a caller-provided sink as they are
 * produced; the caller (the Repo DO) stages them with `staged_push = pushId`.
 *
 * The parser is written against {@link RandomAccess} from day one so the
 * v1.x streaming upgrade (R2-multipart tee + ranged reads) swaps one
 * implementation, not the protocol code (DESIGN §3.6 upgrade seam).
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { applyDelta, DeltaFormatError } from "./Delta.ts";
import {
  bytesToHex,
  decodeOfsDeltaOffset,
  decodeTypeSize,
  hashObject,
  hashObjectSync,
  isDeltaType,
  makeSha1,
  ObjectParseError,
  type ObjectType,
  type Oid,
  type PackEntryType,
} from "./ObjectCodec.ts";
import { type ObjectSource, StoreError } from "./Store.ts";
import {
  deflate,
  inflate,
  inflateEntry,
  inflateEntrySync,
  ZlibError,
} from "./Zlib.ts";

// ─────────────────────────────────────────────────────────────────────────────
// RandomAccess
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Random access over a pack's raw bytes. v1 backs this with the buffered
 * request body ({@link bufferRandomAccess}); the v1.x streaming upgrade backs
 * it with R2 ranged reads without touching the parser.
 */
export interface RandomAccess {
  /**
   * Synchronous read when the range needs no I/O — a view into an
   * in-memory buffer or an already-cached window — else `undefined`. The
   * parser's inner loop uses it to stay synchronous between I/O points
   * (DESIGN §22.5).
   */
  readonly readSync?:
    | ((offset: number, length: number) => Uint8Array | undefined)
    | undefined;
  /**
   * For sources whose total size is not known up front (`size` is
   * `Infinity` while a body is still arriving — DESIGN §22.6): resolves
   * with the final size once the body has ended.
   */
  readonly awaitEnd?: Effect.Effect<number, StoreError> | undefined;
  /** The parser is done with every byte below `offset` (retention hint). */
  readonly release?: ((offset: number) => void) | undefined;
  /**
   * True when `offset` has been dropped from memory and the body has NOT
   * ended yet, i.e. reading it would block on the spill completing. The
   * parser defers such delta entries until the end (DESIGN §22.6).
   */
  readonly evictedBeforeEnd?: ((offset: number) => boolean) | undefined;
  /** Total size of the pack in bytes (`Infinity` while streaming). */
  readonly size: number;
  /**
   * Reads up to `length` bytes at `offset`. May return fewer bytes only when
   * the range extends past the end of the pack. Implementations should return
   * views cheaply (no copy) where possible; callers copy what they retain.
   */
  readonly read: (
    offset: number,
    length: number,
  ) => Effect.Effect<Uint8Array, StoreError>;
}

/**
 * A {@link RandomAccess} over an in-memory buffer. Reads return subarray
 * views (zero copy).
 */
export const bufferRandomAccess = (buf: Uint8Array): RandomAccess => ({
  size: buf.length,
  read: (offset, length) =>
    Effect.sync(() =>
      buf.subarray(offset, Math.min(offset + length, buf.length)),
    ),
  readSync: (offset, length) =>
    buf.subarray(offset, Math.min(offset + length, buf.length)),
  awaitEnd: Effect.succeed(buf.length),
});

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Error raised on malformed pack structure: bad magic/version, truncated
 * entries, entry-count mismatch, size mismatches, or an OFS_DELTA offset that
 * does not land on an entry boundary.
 */
export class PackFormatError extends Schema.TaggedError<PackFormatError>()(
  "PackFormatError",
  { reason: Schema.String },
) {}

/**
 * Error raised when the trailing pack SHA-1 does not match the hash of the
 * preceding bytes (`unpack pack checksum mismatch` on the wire).
 */
export class PackChecksumMismatch extends Schema.TaggedError<PackChecksumMismatch>()(
  "PackChecksumMismatch",
  { expected: Schema.String, actual: Schema.String },
) {}

/**
 * Error raised when an object (or a delta result) exceeds the per-object
 * uncompressed size cap (64 MiB in v1 — DESIGN §3.3).
 */
export class ObjectTooLargeError extends Schema.TaggedError<ObjectTooLargeError>()(
  "ObjectTooLargeError",
  {
    size: Schema.Number,
    limit: Schema.Number,
    oid: Schema.optional(Schema.String),
  },
) {}

/**
 * Error raised when a REF_DELTA's base cannot be found in the pack or in the
 * object store (a thin pack whose base we do not have).
 */
/**
 * A delta's base was evicted from a streaming source before the body ended
 * (DESIGN §22.6). Retried after the end, when the spilled object is
 * readable; never reaches callers.
 */
export class BaseEvictedError extends Schema.TaggedError<BaseEvictedError>()(
  "BaseEvictedError",
  { offset: Schema.Number },
) {}

export class MissingDeltaBaseError extends Schema.TaggedError<MissingDeltaBaseError>()(
  "MissingDeltaBaseError",
  { baseOid: Schema.String },
) {}

/**
 * The full error union pack ingestion can produce.
 */
export type PackIngestError =
  | PackFormatError
  | PackChecksumMismatch
  | ObjectTooLargeError
  | MissingDeltaBaseError
  | ZlibError
  | DeltaFormatError
  | ObjectParseError
  | StoreError
  | BaseEvictedError;

// ─────────────────────────────────────────────────────────────────────────────
// Resolved entries / options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One fully resolved object produced by pack ingestion.
 *
 * `zdata` is `zlib(content)` **without** the loose header — for non-delta
 * entries it is the pack's compressed span verbatim; for delta-resolved
 * entries it is a fresh `deflate(content)` at level 6.
 */
export interface ResolvedEntry {
  readonly oid: Oid;
  readonly type: ObjectType;
  /** Uncompressed size in bytes. */
  readonly size: number;
  /** `zlib(content)`, no loose header. Safe to retain (always a copy). */
  readonly zdata: Uint8Array;
  /** `true` when the entry arrived as a delta and was re-deflated. */
  readonly fromDelta: boolean;
  /**
   * Byte offset of `zdata` within the pack SOURCE for non-delta entries
   * (the compressed span is the pack's bytes verbatim, so a store may
   * reference it in place — DESIGN §22.5); `-1` for delta-resolved entries,
   * whose `zdata` is a fresh deflate that exists nowhere in the pack.
   */
  readonly dataOffset: number;
  /**
   * The inflated bytes. The parser already holds them at this point, so
   * passing them through spares every consumer a second inflate just to
   * read a commit or tree.
   */
  readonly content: Uint8Array;
}

/**
 * Summary returned by {@link ingestPack} after the trailer verifies.
 */
export interface IngestSummary {
  /** Number of entries in the pack (the header count). */
  readonly count: number;
  /** The oids of every resolved entry, in emission order. */
  readonly oids: ReadonlyArray<Oid>;
}

/** Default per-object uncompressed size cap: 64 MiB (DESIGN §3.3). */
export const DEFAULT_MAX_OBJECT_SIZE = 64 * 1024 * 1024;

/** Default resolved-content LRU budget: 20 MiB (DESIGN §3.6). */
export const DEFAULT_CACHE_BYTES = 20 * 1024 * 1024;

/** Per-entry cache admission cap: entries larger than this are never cached. */
const MAX_CACHE_ENTRY_BYTES = 10 * 1024 * 1024;

/**
 * Bytes read per entry before growing (see the read in the main pass).
 * Sized so virtually every git object — a few KiB — is covered by one read,
 * which is what keeps ingest from a remote source proportional to the pack
 * size rather than to entries × pack size.
 */
/**
 * Bytes probed per entry before inflating. In-window reads are views on
 * both sources, so the probe's size costs nothing — except when it crosses
 * a window edge on the spilled (blob-backed) source, where the reader must
 * assemble a copy. 64 KiB keeps such crossings rare (only entries within
 * 64 KiB of a 4 MiB edge) and small; the rare larger entry grows the
 * window on demand (DESIGN §22.4 — 512 KiB here was ~1 GB of copies per
 * 15k-object spilled push).
 */
const ENTRY_WINDOW_BYTES = 64 * 1024;

/** Non-delta entries handed to `sinkBatch` per fiber hop (DESIGN §22.5). */
export const SINK_BATCH = 256;

/**
 * Options for {@link ingestPack}.
 */
/** What the parser needs from the live store: thin-delta bases. */
export interface ThinBaseSource {
  /** A live object's type and content, or `undefined` when absent. */
  readonly readBase: (
    oid: Oid,
  ) => Effect.Effect<
    { readonly type: ObjectType; readonly content: Uint8Array } | undefined,
    StoreError
  >;
}

export interface IngestPackOptions<E, R> {
  /** The pack bytes. */
  readonly source: RandomAccess;
  /** Live objects, used to resolve thin REF_DELTA bases. */
  readonly store: ThinBaseSource;
  /** Receives each resolved entry as it is produced (staging inserts). */
  readonly sink: (entry: ResolvedEntry) => Effect.Effect<void, E, R>;
  /**
   * Optional batched sink: receives runs of entries the synchronous inner
   * loop produced without any I/O between them (DESIGN §22.5). When set,
   * non-delta entries go here in batches of up to `SINK_BATCH` and `sink`
   * receives only delta-resolved entries.
   */
  readonly sinkBatch?:
    | ((entries: ReadonlyArray<ResolvedEntry>) => Effect.Effect<void, E, R>)
    | undefined;
  /** Per-object uncompressed cap; default {@link DEFAULT_MAX_OBJECT_SIZE}. */
  readonly maxObjectSize?: number | undefined;
  /**
   * Optional per-phase CPU accounting (ms), accumulated in place:
   * `inflate`, `hash`, `delta`, `deflate`, `copy`, `sink`. Cheap enough
   * to leave on: two `performance.now()` calls per phase per object.
   */
  readonly phases?: Record<string, number> | undefined;
  /** Resolved-content LRU budget; default {@link DEFAULT_CACHE_BYTES}. */
  readonly cacheBytes?: number | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

interface CachedContent {
  readonly type: ObjectType;
  readonly content: Uint8Array;
}

/** Insertion-order LRU bounded by total content bytes. */
class ByteLru {
  private readonly map = new Map<string, CachedContent>();
  private bytes = 0;
  constructor(private readonly capacity: number) {}

  get(key: string): CachedContent | undefined {
    const hit = this.map.get(key);
    if (hit !== undefined) {
      // refresh recency
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: string, entry: CachedContent): void {
    if (entry.content.length > MAX_CACHE_ENTRY_BYTES) return;
    if (this.map.has(key)) return;
    this.map.set(key, entry);
    this.bytes += entry.content.length;
    while (this.bytes > this.capacity && this.map.size > 1) {
      const oldest = this.map.keys().next().value as string;
      const evicted = this.map.get(oldest)!;
      this.map.delete(oldest);
      this.bytes -= evicted.content.length;
    }
  }
}

interface IndexedEntry {
  /** Absolute offset of the entry header in the pack. */
  readonly offset: number;
  readonly entryType: PackEntryType;
  /** Declared uncompressed size (for deltas: of the delta payload). */
  readonly declaredSize: number;
  /** Absolute offset of the zlib stream. */
  readonly dataOffset: number;
  /** Exact compressed span in bytes. */
  readonly span: number;
  /** OFS_DELTA: absolute offset of the base entry. */
  readonly baseOffset: number | undefined;
  /** REF_DELTA: base object id. */
  readonly baseOid: Oid | undefined;
  /** Set once the entry has been resolved and emitted. */
  resolved?: { readonly oid: Oid; readonly type: ObjectType };
}

const readU32BE = (buf: Uint8Array, offset: number): number =>
  ((buf[offset]! << 24) |
    (buf[offset + 1]! << 16) |
    (buf[offset + 2]! << 8) |
    buf[offset + 3]!) >>>
  0;

/**
 * Reads and validates the 12-byte pack header (`PACK`, version 2, entry
 * count).
 */
export const readPackHeader = Effect.fn(function* (source: RandomAccess) {
  if (Number.isFinite(source.size) && source.size < 12 + 20) {
    return yield* new PackFormatError({
      reason: `pack too small: ${source.size} bytes`,
    });
  }
  const header = yield* source.read(0, 12);
  if (header.length < 12) {
    return yield* new PackFormatError({
      reason: `pack too small: ${header.length} bytes`,
    });
  }
  if (
    header.length < 12 ||
    header[0] !== 0x50 || // P
    header[1] !== 0x41 || // A
    header[2] !== 0x43 || // C
    header[3] !== 0x4b // K
  ) {
    return yield* new PackFormatError({ reason: "bad pack magic" });
  }
  const version = readU32BE(header, 4);
  if (version !== 2) {
    return yield* new PackFormatError({
      reason: `unsupported pack version ${version}`,
    });
  }
  const count = readU32BE(header, 8);
  return { version, count };
});

// ─────────────────────────────────────────────────────────────────────────────
// Ingest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ingests a complete pack: parses every entry, resolves OFS/REF deltas
 * (including thin bases from the object store), verifies the trailing SHA-1,
 * and emits each resolved object to `options.sink`.
 *
 * Entries are emitted in pack order, except REF_DELTA entries whose base
 * appears *later* in the pack (legal but rare) — those are deferred and
 * emitted after the main pass.
 *
 * Memory: the resolved-content LRU is bounded by `cacheBytes`; cache misses
 * re-inflate from the source. Only one resolved object (plus its base) is
 * otherwise live at a time.
 */
export const ingestPack = <E, R>(
  options: IngestPackOptions<E, R>,
): Effect.Effect<IngestSummary, PackIngestError | E, R> =>
  Effect.gen(function* () {
    const { sink, source, store } = options;
    const phases = options.phases;
    const timed = <A, E2, R2>(
      phase: string,
      effect: Effect.Effect<A, E2, R2>,
    ): Effect.Effect<A, E2, R2> =>
      phases === undefined
        ? effect
        : Effect.suspend(() => {
            const at = performance.now();
            return Effect.ensuring(
              effect,
              Effect.sync(() => {
                phases[phase] = (phases[phase] ?? 0) + (performance.now() - at);
              }),
            );
          });
    const maxObjectSize = options.maxObjectSize ?? DEFAULT_MAX_OBJECT_SIZE;
    const cache = new ByteLru(options.cacheBytes ?? DEFAULT_CACHE_BYTES);
    const { count } = yield* readPackHeader(source);
    // Unknown while a streaming body is still arriving (DESIGN §22.6); the
    // loop is driven by `count`, and the true end is learned from
    // `awaitEnd` before the trailer is checked.
    let dataEnd = Number.isFinite(source.size)
      ? source.size - 20
      : Number.POSITIVE_INFINITY;
    // The trailer SHA-1 is accumulated as entries are consumed instead of
    // re-reading the whole pack afterwards (on a spilled source that was
    // another full pass of window reads).
    const trailerSha = makeSha1();
    trailerSha.update(yield* source.read(0, 12));

    const byOffset = new Map<number, IndexedEntry>();
    /** oid → entry offset, for in-pack REF_DELTA base lookup. */
    const offsetByOid = new Map<Oid, number>();
    const oids: Array<Oid> = [];
    const deferred: Array<IndexedEntry> = [];

    /** Inflates an already-indexed entry's own zlib stream (exact span). */
    const inflateOwn = (
      entry: IndexedEntry,
    ): Effect.Effect<Uint8Array, PackIngestError> =>
      Effect.suspend((): Effect.Effect<Uint8Array, PackIngestError> =>
        source.evictedBeforeEnd?.(entry.dataOffset) === true
          ? Effect.fail(new BaseEvictedError({ offset: entry.dataOffset }))
          : source
              .read(entry.dataOffset, entry.span)
              .pipe(Effect.flatMap((z) => inflate(z))),
      );

    /**
     * Resolves an entry to its full content, walking delta chains. Bases come
     * from the LRU, from re-inflation of earlier pack entries, or (thin
     * REF_DELTA) from the object store.
     */
    const resolveContent = (
      entry: IndexedEntry,
    ): Effect.Effect<CachedContent, PackIngestError> =>
      Effect.gen(function* () {
        const key = `ofs:${entry.offset}`;
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        let result: CachedContent;
        if (!isDeltaType(entry.entryType)) {
          const content = yield* inflateOwn(entry);
          result = { type: entry.entryType as ObjectType, content };
        } else {
          const base = yield* resolveBase(entry);
          const payload = yield* timed("inflate", inflateOwn(entry));
          const content = yield* timed(
            "delta",
            applyDelta(base.content, payload),
          );
          if (content.length > maxObjectSize) {
            return yield* new ObjectTooLargeError({
              size: content.length,
              limit: maxObjectSize,
            });
          }
          result = { type: base.type, content };
        }
        cache.set(key, result);
        return result;
      });

    /** Resolves a delta entry's base content. */
    const resolveBase = (
      entry: IndexedEntry,
    ): Effect.Effect<CachedContent, PackIngestError> =>
      Effect.gen(function* () {
        if (entry.baseOffset !== undefined) {
          const base = byOffset.get(entry.baseOffset);
          if (base === undefined) {
            return yield* new PackFormatError({
              reason: `ofs-delta at ${entry.offset} points at ${entry.baseOffset}, not an entry boundary`,
            });
          }
          return yield* resolveContent(base);
        }
        const baseOid = entry.baseOid!;
        const inPack = offsetByOid.get(baseOid);
        if (inPack !== undefined) {
          return yield* resolveContent(byOffset.get(inPack)!);
        }
        const cachedThin = cache.get(`oid:${baseOid}`);
        if (cachedThin !== undefined) return cachedThin;
        const live = yield* store.readBase(baseOid);
        if (live === undefined) {
          return yield* new MissingDeltaBaseError({ baseOid });
        }
        if (live.content.length > maxObjectSize) {
          return yield* new ObjectTooLargeError({
            size: live.content.length,
            limit: maxObjectSize,
            oid: baseOid,
          });
        }
        const thin: CachedContent = { type: live.type, content: live.content };
        cache.set(`oid:${baseOid}`, thin);
        return thin;
      });

    /** Resolves, hashes, deflates, and emits one delta entry. */
    const emitDelta = (entry: IndexedEntry) =>
      Effect.gen(function* () {
        const { content, type } = yield* resolveContent(entry);
        const oid = yield* timed("hash", hashObject(type, content));
        const zdata = yield* timed("deflate", deflate(content));
        entry.resolved = { oid, type };
        offsetByOid.set(oid, entry.offset);
        oids.push(oid);
        yield* timed(
          "sink",
          sink({
            oid,
            type,
            size: content.length,
            zdata,
            fromDelta: true,
            dataOffset: -1,
            content,
          }),
        );
      });

    // ── main pass: index + resolve in pack order ─────────────────────────────
    const sinkBatch = options.sinkBatch;
    let pendingSink: Array<ResolvedEntry> = [];
    // On a streaming source the body arrives through the event loop, and
    // a synchronous batch monopolizes the isolate: without a real
    // (macrotask) yield between batches, receive and parse alternate
    // instead of overlapping (DESIGN §22.6). Fiber yields are not enough —
    // they stay within the same task.
    const streaming = !Number.isFinite(source.size);
    const breathe = streaming
      ? Effect.promise(
          () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
        )
      : Effect.void;
    const flushPending = Effect.suspend(() => {
      if (pendingSink.length === 0 || sinkBatch === undefined) return breathe;
      const batch = pendingSink;
      pendingSink = [];
      return timed("sink", sinkBatch(batch)).pipe(Effect.andThen(breathe));
    });
    /**
     * The synchronous fast path (DESIGN §22.5): a non-delta entry whose
     * bytes are already in memory is decoded, inflated, hashed and copied
     * without a single fiber hop. Returns the next offset, `undefined` to
     * fall through to the general path (a delta, an entry outrunning the
     * window, or no sync inflate), or an error to fail with.
     */
    const syncEntry = (
      window: Uint8Array,
      offset: number,
      i: number,
    ): number | undefined | PackFormatError | ObjectTooLargeError => {
      let header;
      try {
        header = decodeTypeSize(window, 0);
      } catch (error) {
        return new PackFormatError({
          reason:
            error instanceof ObjectParseError
              ? `entry ${i}: ${error.reason}`
              : `entry ${i}: ${String(error)}`,
        });
      }
      if (isDeltaType(header.type)) return undefined;
      if (header.size > maxObjectSize) {
        return new ObjectTooLargeError({
          size: header.size,
          limit: maxObjectSize,
        });
      }
      const pos = header.next;
      const inflated = inflateEntrySync(window, pos, {
        maxOutput: maxObjectSize,
        expectedSize: header.size,
      });
      if (inflated === undefined) return undefined;
      const { bytesConsumed, content } = inflated;
      if (content.length !== header.size) {
        return new PackFormatError({
          reason: `entry ${i}: inflated ${content.length} bytes, header declared ${header.size}`,
        });
      }
      const type = header.type as ObjectType;
      const oid = hashObjectSync(type, content);
      const dataOffset = offset + pos;
      const zdata = Uint8Array.from(window.subarray(pos, pos + bytesConsumed));
      const entry: IndexedEntry = {
        offset,
        entryType: header.type,
        declaredSize: header.size,
        dataOffset,
        span: bytesConsumed,
        baseOffset: undefined,
        baseOid: undefined,
        resolved: { oid, type },
      };
      byOffset.set(offset, entry);
      offsetByOid.set(oid, offset);
      cache.set(`ofs:${offset}`, { type, content });
      oids.push(oid);
      pendingSink.push({
        oid,
        type,
        size: content.length,
        zdata,
        fromDelta: false,
        dataOffset,
        content,
      });
      trailerSha.update(window.subarray(0, pos + bytesConsumed));
      source.release?.(offset);
      return dataOffset + bytesConsumed;
    };

    let offset = 12;
    for (let i = 0; i < count; i++) {
      if (offset >= dataEnd) {
        return yield* new PackFormatError({
          reason: `truncated pack: entry ${i} of ${count} starts past the trailer`,
        });
      }
      // Read a BOUNDED window, not the rest of the pack.
      //
      // `source.read(offset, dataEnd - offset)` is free on a buffer (a
      // subarray view) but catastrophic on a remote source: it copies the
      // whole remainder once per entry, so a 13.7k-object pack in R2 moved
      // hundreds of GB and took minutes instead of seconds. An entry is
      // almost always a few KiB, so one small window covers it; the rare
      // large object grows the window on demand (below).
      const probeLength = Math.min(ENTRY_WINDOW_BYTES, dataEnd - offset);
      const direct = source.readSync?.(offset, probeLength);
      if (direct !== undefined) {
        const at = phases === undefined ? 0 : performance.now();
        const next = syncEntry(direct, offset, i);
        if (phases !== undefined) {
          phases["sync"] = (phases["sync"] ?? 0) + (performance.now() - at);
        }
        if (typeof next === "number") {
          offset = next;
          if (sinkBatch === undefined) {
            const entry = pendingSink.pop()!;
            yield* timed("sink", sink(entry));
          } else if (pendingSink.length >= SINK_BATCH) {
            yield* flushPending;
          }
          continue;
        }
        if (next !== undefined) return yield* Effect.fail(next);
      }
      let window = yield* source.read(offset, probeLength);
      if (window.length === 0) {
        return yield* new PackFormatError({
          reason: `truncated pack: entry ${i} of ${count} starts past the end`,
        });
      }
      /**
       * Re-reads a bigger window when an entry's compressed stream runs past
       * the current one. Doubling from the entry window reaches the whole
       * remainder in a handful of steps, and only for objects that need it.
       */
      const growWindow = Effect.fn(function* (needed: number) {
        const size = Math.min(
          Math.max(needed, window.length * 2),
          dataEnd - offset,
        );
        if (size <= window.length) return false;
        window = yield* source.read(offset, size);
        return true;
      });
      let header;
      try {
        header = decodeTypeSize(window, 0);
      } catch (error) {
        return yield* new PackFormatError({
          reason:
            error instanceof ObjectParseError
              ? `entry ${i}: ${error.reason}`
              : `entry ${i}: ${String(error)}`,
        });
      }
      let pos = header.next;
      let baseOffset: number | undefined;
      let baseOid: Oid | undefined;
      if (header.type === 6) {
        let ofs;
        try {
          ofs = decodeOfsDeltaOffset(window, pos);
        } catch (error) {
          return yield* new PackFormatError({
            reason:
              error instanceof ObjectParseError
                ? `entry ${i}: ${error.reason}`
                : `entry ${i}: ${String(error)}`,
          });
        }
        pos = ofs.next;
        baseOffset = offset - ofs.value;
        if (baseOffset < 12) {
          return yield* new PackFormatError({
            reason: `entry ${i}: ofs-delta offset ${ofs.value} points before the first entry`,
          });
        }
      } else if (header.type === 7) {
        if (pos + 20 > window.length) {
          return yield* new PackFormatError({
            reason: `entry ${i}: truncated ref-delta base id`,
          });
        }
        baseOid = bytesToHex(window.subarray(pos, pos + 20));
        pos += 20;
      } else if (header.size > maxObjectSize) {
        return yield* new ObjectTooLargeError({
          size: header.size,
          limit: maxObjectSize,
        });
      }

      // An entry whose compressed stream runs past the window grows it and
      // retries; virtually every object fits the first read.
      const inflateOptions = {
        maxOutput: maxObjectSize,
        // Lets the synchronous fast path verify itself (see Zlib.ts).
        expectedSize: header.size,
      };
      let attempt = yield* Effect.result(
        timed("inflate", inflateEntry(window, pos, inflateOptions)),
      );
      // The header declares the uncompressed size; the compressed span is
      // at most that plus deflate's own overhead, so one grow reaches an
      // entry that outran the probe instead of doubling toward it (each
      // failed attempt below costs up to three inflate passes).
      while (
        Result.isFailure(attempt) &&
        (yield* growWindow(
          Math.max(window.length * 2, pos + header.size + 64 * 1024),
        ))
      ) {
        attempt = yield* Effect.result(
          inflateEntry(window, pos, inflateOptions),
        );
      }
      if (Result.isFailure(attempt)) {
        return yield* Effect.fail(attempt.failure);
      }
      const { bytesConsumed, content } = attempt.success;
      if (content.length !== header.size) {
        return yield* new PackFormatError({
          reason: `entry ${i}: inflated ${content.length} bytes, header declared ${header.size}`,
        });
      }
      const dataOffset = offset + pos;
      const entry: IndexedEntry = {
        offset,
        entryType: header.type,
        declaredSize: header.size,
        dataOffset,
        span: bytesConsumed,
        baseOffset,
        baseOid,
      };
      byOffset.set(offset, entry);

      if (!isDeltaType(header.type)) {
        const type = header.type as ObjectType;
        const oid = yield* timed("hash", hashObject(type, content));
        // keep the compressed span verbatim — copy it out of the shared buffer
        const zview = yield* source.read(dataOffset, bytesConsumed);
        const zdata = yield* timed(
          "copy",
          Effect.sync(() => Uint8Array.from(zview)),
        );
        entry.resolved = { oid, type };
        offsetByOid.set(oid, entry.offset);
        cache.set(`ofs:${offset}`, { type, content });
        oids.push(oid);
        yield* timed(
          "sink",
          sink({
            oid,
            type,
            size: content.length,
            zdata,
            fromDelta: false,
            dataOffset,
            content,
          }),
        );
      } else {
        const result = yield* Effect.result(emitDelta(entry));
        if (Result.isFailure(result)) {
          if (
            result.failure instanceof MissingDeltaBaseError ||
            result.failure instanceof BaseEvictedError
          ) {
            // The base may appear later in the pack (thin ref-delta), or
            // it was evicted from a streaming source and is readable once
            // the body has ended: retry in the deferred pass.
            deferred.push(entry);
          } else {
            return yield* Effect.fail(result.failure);
          }
        }
      }
      trailerSha.update(window.subarray(0, pos + bytesConsumed));
      source.release?.(offset);
      offset = dataOffset + bytesConsumed;
    }

    yield* flushPending;
    if (!Number.isFinite(dataEnd)) {
      if (source.awaitEnd === undefined) {
        return yield* new PackFormatError({
          reason: "pack source has unknown size and no awaitEnd",
        });
      }
      dataEnd = (yield* source.awaitEnd) - 20;
    }
    // ── deferred deltas: fixpoint passes AFTER the end ───────────────────────
    // REF_DELTAs whose base came later in the pack, and (streaming) deltas
    // whose base had been evicted before the body ended — readable now
    // through the spilled object.
    let pending = deferred;
    while (pending.length > 0) {
      const next: Array<IndexedEntry> = [];
      let firstMissing: MissingDeltaBaseError | undefined;
      for (const entry of pending) {
        const result = yield* Effect.result(emitDelta(entry));
        if (Result.isFailure(result)) {
          if (result.failure instanceof MissingDeltaBaseError) {
            firstMissing ??= result.failure;
            next.push(entry);
          } else if (result.failure instanceof BaseEvictedError) {
            return yield* new PackFormatError({
              reason: `delta base at ${result.failure.offset} unreadable after the body ended`,
            });
          } else {
            return yield* Effect.fail(result.failure);
          }
        }
      }
      if (next.length === pending.length) {
        // no progress — the base genuinely does not exist anywhere
        return yield* Effect.fail(firstMissing!);
      }
      pending = next;
    }
    if (offset !== dataEnd) {
      return yield* new PackFormatError({
        reason: `pack has ${dataEnd - offset} unconsumed bytes after ${count} entries`,
      });
    }

    // ── trailer verification ─────────────────────────────────────────────────
    const trailer = yield* source.read(dataEnd, 20);
    if (trailer.length < 20) {
      return yield* new PackFormatError({ reason: "truncated pack trailer" });
    }
    const expected = bytesToHex(trailer);
    const actual = yield* Effect.sync(() => trailerSha.digestHex());
    if (expected !== actual) {
      return yield* new PackChecksumMismatch({ expected, actual });
    }

    return { count, oids } satisfies IngestSummary;
  });
