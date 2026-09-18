import { LIVE_OBJECTS } from "../Store/ObjectStore.ts";
/**
 * The compaction alarm job (DESIGN.md §12.1) — the v2 storage plane.
 *
 * v1 keeps every object's bytes in a DO SQLite row, which caps a repo at the
 * 10 GB DO limit and puts all clone bandwidth behind one single-threaded
 * object. Compaction moves those bytes into **immutable, content-addressed
 * R2 packs** and leaves only the index behind:
 *
 * ```
 * objects.location: 'row'  →  'pack'
 * objects.zdata:    BLOB   →  NULL     (bytes now live in R2)
 * objects.pack_id / pack_offset:       (where in R2 they live)
 * ```
 *
 * The pack we write is a **real git packfile** (`PACK`, version 2, count,
 * then `varint(type,size) + zdata` per entry, then the SHA-1 trailer), so it
 * can later be served verbatim as a clone bundle or a `packfile-uris`
 * target. That works only because objects are stored **pre-deflated**: a
 * pack entry is the stored bytes with a small header in front, so compaction
 * is a copy, never a recompression.
 *
 * `pack_offset` deliberately addresses each object's **zdata span**, not its
 * entry header — a read is then one ranged R2 GET returning exactly the
 * bytes a `location='row'` object would have held (see `ObjectStore`).
 *
 * Bounded per run and alarm-re-armable, like the purge job: at most
 * {@link MAX_OBJECTS_PER_RUN} objects / {@link MAX_BYTES_PER_RUN} bytes are
 * moved per alarm, and the job reports whether more remain.
 */
import type { BlobStoreError, BlobStoreShape } from "../BlobStore.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import * as Effect from "effect/Effect";
import {
  concatBytes,
  bytesToHex,
  encodeTypeSize,
  makeSha1,
  type PackEntryType,
} from "../Protocol/ObjectCodec.ts";
import { StoreError } from "../Protocol/Store.ts";
import { packKey, isWirePackId, packKeyOf } from "../Store/Keys.ts";
import type { SqlClient } from "../Store/Sql.ts";

/** Objects moved per alarm run. */
export const MAX_OBJECTS_PER_RUN = 2_000;

/**
 * Byte budget per alarm run (assembled in memory before the R2 put). Well
 * under the 128 MB isolate limit; the streaming-multipart upgrade lifts it.
 */
export const MAX_BYTES_PER_RUN = 32 * 1024 * 1024;

/**
 * Loose-bytes threshold that arms compaction (DESIGN.md §12.1).
 */
// Measured (DESIGN §22): a 44k-object repo left loose serves its dynamic
// path at ~3 MB/s from 44k SQLite point reads, and every metadata scan
// walks pages dense with inline zdata. Packing early is what makes reads
// window-coalesced and keeps the objects table small.
export const COMPACT_BYTES_THRESHOLD = 64 * 1024 * 1024;

/** Loose-object-count threshold that arms compaction. */
export const COMPACT_COUNT_THRESHOLD = 4_000;

/**
 * Only blobs (git type 3) are ever moved into R2 packs. Commits, trees and
 * tags stay `location='row'` in SQLite for the life of the repo.
 *
 * Measured (DESIGN §22): a fetch's want→have closure is a tree walk, and a
 * tree walk over pack storage is the worst access pattern a window cache
 * can see — trees are tiny and, packed in oid order, scattered across
 * every 4 MiB window of every pack. On a 15.6k-object repo the walk alone
 * cost 12 s of TTFB (27 s before batching); the same walk over rows is a
 * handful of batched SELECTs. Trees + commits are a few percent of a
 * repo's bytes, so keeping them local buys sub-second negotiation for
 * every incremental fetch at negligible storage cost.
 */
export const BLOB_TYPE = 3;

/** Outcome of one compaction run. */
export interface CompactOutcome {
  /** Objects moved into the pack this run. */
  readonly moved: number;
  /** Bytes of zdata moved. */
  readonly bytes: number;
  /** sha1 of the pack written (the rows' `pack_id`), else `undefined`. */
  readonly packId: string | undefined;
  /** True when loose objects remain — the caller re-arms the alarm. */
  readonly more: boolean;
}

/** Dependencies of {@link runCompactJob}. */
export interface CompactJobOptions {
  readonly repoId: string;
  readonly sql: SqlClient;
  readonly blobs: BlobStoreShape;
  readonly maxObjects?: number | undefined;
  readonly maxBytes?: number | undefined;
}

interface LooseRow extends Record<
  string,
  string | number | ArrayBuffer | null
> {
  readonly oid: string;
  readonly type: number;
  readonly size: number;
  readonly zsize: number;
  readonly zdata: ArrayBuffer | null;
}

const runR2 =
  (what: string) =>
  <A>(
    effect: Effect.Effect<A, BlobStoreError, RuntimeContext>,
  ): Effect.Effect<A, StoreError> =>
    effect.pipe(
      Effect.mapError(
        (error) => new StoreError({ reason: `${what}: ${error.reason}` }),
      ),
      Effect.provide(RuntimeContext.phantom),
    );

const PACK_SIGNATURE = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // "PACK"

/** `PACK` + version 2 + object count. */
const packHeader = (count: number): Uint8Array => {
  const header = new Uint8Array(12);
  header.set(PACK_SIGNATURE, 0);
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, count);
  return header;
};

/**
 * Compacts up to one run's worth of loose objects into a single immutable
 * R2 pack and repoints their rows at it.
 *
 * Ordering note: the R2 put happens **before** the row flip, so a crash in
 * between leaves an unreferenced pack (harmless, content-addressed, GC-able)
 * rather than rows pointing at bytes that do not exist.
 */
export const runCompactJob = (
  options: CompactJobOptions,
): Effect.Effect<CompactOutcome, StoreError> =>
  Effect.gen(function* () {
    const maxObjects = options.maxObjects ?? MAX_OBJECTS_PER_RUN;
    const maxBytes = options.maxBytes ?? MAX_BYTES_PER_RUN;

    // Oldest-first by oid keeps runs deterministic and re-runnable.
    const rows = yield* options.sql.all<LooseRow>(
      `SELECT oid, type, size, zsize, zdata FROM objects
        WHERE location = 'row' AND type = ${BLOB_TYPE} AND ${LIVE_OBJECTS}
        ORDER BY oid LIMIT ?`,
      maxObjects + 1,
    );
    const eligible = rows.slice(0, maxObjects);
    if (eligible.length === 0) {
      return { moved: 0, bytes: 0, packId: undefined, more: false };
    }

    // Assemble the pack, recording each object's zdata offset as we go.
    const chunks: Array<Uint8Array> = [];
    const placements: Array<{ oid: string; offset: number; zsize: number }> =
      [];
    let offset = 0;
    let budget = 0;
    const push = (bytes: Uint8Array) => {
      chunks.push(bytes);
      offset += bytes.length;
    };

    const included: Array<LooseRow> = [];
    for (const row of eligible) {
      if (row.zdata === null) continue; // location='row' with NULL zdata: skip
      const zdata = new Uint8Array(row.zdata);
      if (budget > 0 && budget + zdata.length > maxBytes) break;
      included.push(row);
      budget += zdata.length;
      push(
        yield* Effect.sync(() =>
          // Row types are the 1..4 non-delta git types (the ingest path only
          // ever stores those), which is exactly `PackEntryType`.
          encodeTypeSize(row.type as PackEntryType, row.size),
        ),
      );
      placements.push({ oid: row.oid, offset, zsize: zdata.length });
      push(zdata);
    }
    if (included.length === 0) {
      return { moved: 0, bytes: 0, packId: undefined, more: false };
    }

    const header = packHeader(included.length);
    const body = [header, ...chunks];
    // One pass: the raw digest is the pack trailer, its hex is the pack id
    // (content-addressed, so a retried run rewrites the identical key).
    const trailer = yield* Effect.sync(() => {
      const hash = makeSha1();
      for (const chunk of body) hash.update(chunk);
      return hash.digest();
    });
    const trailerHex = yield* Effect.sync(() => bytesToHex(trailer));

    const total =
      body.reduce((sum, chunk) => sum + chunk.length, 0) + trailer.length;
    const pack = yield* Effect.sync(() => {
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of body) {
        out.set(chunk, at);
        at += chunk.length;
      }
      out.set(trailer, at);
      return out;
    });

    // Offsets recorded above are relative to the start of the entry stream;
    // shift them past the 12-byte header to get absolute file offsets.
    const packId = trailerHex;
    const key = packKey(options.repoId, packId);
    yield* runR2(`blob put ${key}`)(
      options.blobs.put(key, pack, { contentLength: pack.length }),
    );

    yield* options.sql
      .transactionSync((raw) => {
        for (const placement of placements) {
          raw.exec(
            `UPDATE objects
                SET location = 'pack', pack_id = ?, pack_offset = ?, zdata = NULL
              WHERE oid = ? AND location = 'row' AND ${LIVE_OBJECTS}`,
            packId,
            placement.offset + header.length,
            placement.oid,
          );
        }
      })
      .pipe(Effect.asVoid);

    return {
      moved: included.length,
      bytes: budget,
      packId,
      more: rows.length > maxObjects || included.length < eligible.length,
    };
  });

/**
 * True when the repo has enough loose bytes/objects to be worth compacting
 * (DESIGN.md §12.1 thresholds).
 */
export const shouldCompact = (
  sql: SqlClient,
  options?: {
    readonly bytesThreshold?: number | undefined;
    readonly countThreshold?: number | undefined;
  },
): Effect.Effect<boolean, StoreError> =>
  Effect.gen(function* () {
    const row = yield* sql.first<{ n: number; bytes: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(zsize), 0) AS bytes
         FROM objects WHERE location = 'row' AND type = ${BLOB_TYPE} AND ${LIVE_OBJECTS}`,
    );
    if (row === undefined) return false;
    return (
      row.bytes >= (options?.bytesThreshold ?? COMPACT_BYTES_THRESHOLD) ||
      row.n >= (options?.countThreshold ?? COMPACT_COUNT_THRESHOLD)
    );
  });

// ─────────────────────────────────────────────────────────────────────────────
// Geometric pack merging (DESIGN.md §21, Continuity learnings)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge whenever a pack is smaller than FACTOR × the sum of all packs
 * smaller than it — the classic geometric invariant. Holding it bounds
 * pack count at O(log(total bytes)), which bounds the fan-out of ranged
 * reads on the serving path.
 */
export const GEOMETRIC_FACTOR = 2;

/** Per-run ceiling on merged input, keeping a run inside the alarm budget. */
export const MAX_MERGE_INPUT_BYTES = 96 * 1024 * 1024;

export interface MergeOutcome {
  /** Source packs merged this run (0 = the invariant already holds). */
  readonly packs: number;
  /** Objects now pointing at the merged pack. */
  readonly moved: number;
  /** Bytes of merged pack written. */
  readonly bytes: number;
  readonly packId: string | undefined;
  /**
   * R2 keys of the source packs, now unreferenced. NOT deleted here: an
   * in-flight read planned before the row flip may still hold spans into
   * them, so the caller deletes these on a LATER run (grace period).
   */
  readonly pendingDelete: ReadonlyArray<string>;
  /** More merging remains (input cap hit); re-arm the alarm. */
  readonly more: boolean;
}

const noMerge: MergeOutcome = {
  packs: 0,
  moved: 0,
  bytes: 0,
  packId: undefined,
  pendingDelete: [],
  more: false,
};

/**
 * Restores the geometric invariant over a repo's compacted packs by
 * merging the smallest run of violating packs into one.
 *
 * Merging is pure concatenation — our packs store non-delta entries
 * (varint header + zdata), so a merged pack is `header(Σcounts) +
 * body₁ + … + bodyₙ + sha1`, and every row's offset shifts by a single
 * per-source delta (the bytes of bodies concatenated before it). No
 * recompression, no delta re-resolution: O(bytes) of blob IO plus one
 * UPDATE per source pack.
 *
 * Ordering matches {@link runCompactJob}: the merged pack is written
 * before the row flip (a crash between leaves an unreferenced,
 * content-addressed, GC-able pack), and source packs are only deleted by
 * the caller on a later run.
 */
export const runGeometricMergeJob = (options: {
  readonly repoId: string;
  readonly sql: SqlClient;
  readonly blobs: BlobStoreShape;
  readonly maxInputBytes?: number | undefined;
}): Effect.Effect<MergeOutcome, StoreError> =>
  Effect.gen(function* () {
    const maxInput = options.maxInputBytes ?? MAX_MERGE_INPUT_BYTES;

    const rows = yield* options.sql.all<{ pack_id: string; n: number }>(
      `SELECT pack_id, COUNT(*) AS n FROM objects
        WHERE location = 'pack' AND pack_id IS NOT NULL
        GROUP BY pack_id`,
    );
    if (rows.length < 2) return noMerge;

    // Exact byte sizes from the store (offsets are absolute file offsets,
    // so the merge math needs real lengths, not row sums).
    const packs: Array<{ id: string; count: number; size: number }> = [];
    for (const row of rows) {
      const meta = yield* runR2(`merge head ${row.pack_id}`)(
        options.blobs.head(packKeyOf(options.repoId, row.pack_id)),
      );
      // A pack R2 lost (or a crash orphaned) cannot be merged; skip it —
      // reads through it will surface the real error on their own path.
      if (meta !== null) {
        packs.push({ id: row.pack_id, count: row.n, size: meta.size });
      }
    }
    if (packs.length < 2) return noMerge;
    packs.sort((a, b) => a.size - b.size);

    // Geometric scan from the smallest: everything up to the last
    // violation must merge.
    let cumulative = 0;
    let mergeCount = 0;
    for (let i = 0; i < packs.length; i++) {
      if (i >= 1 && packs[i]!.size < GEOMETRIC_FACTOR * cumulative) {
        mergeCount = i + 1;
      }
      cumulative += packs[i]!.size;
    }
    if (mergeCount < 2) return noMerge;

    // Cap the run's input; ≥2 sources or there is nothing useful to do.
    let inputBytes = 0;
    let take = 0;
    while (take < mergeCount && inputBytes + packs[take]!.size <= maxInput) {
      inputBytes += packs[take]!.size;
      take++;
    }
    if (take < 2) return noMerge;
    const sources = packs.slice(0, take);
    const more = take < mergeCount;

    // Read + validate each source, strip framing, record body deltas.
    const bodies: Array<Uint8Array> = [];
    const deltas: Array<{ id: string; delta: number }> = [];
    // Promoted wire packs (DESIGN §22.5) also carry the push's trees,
    // commits and delta entries, so they are REWRITTEN rather than
    // concatenated: only the rows that reference them are copied, each as
    // a regenerated typeSize header + its compressed span, and every row
    // is repointed individually.
    const rewrites: Array<{ oid: string; offset: number }> = [];
    let totalCount = 0;
    let bodyOffset = 0;
    for (const source of sources) {
      const object = yield* runR2(`merge get ${source.id}`)(
        options.blobs.get(packKeyOf(options.repoId, source.id)),
      );
      if (object === null) return noMerge; // vanished mid-run: retry later
      const bytes = yield* runR2(`merge read ${source.id}`)(object.bytes);
      if (isWirePackId(source.id)) {
        const rows = yield* options.sql.all<{
          oid: string;
          type: number;
          size: number;
          zsize: number;
          pack_offset: number;
        }>(
          `SELECT oid, type, size, zsize, pack_offset FROM objects
             WHERE location = 'pack' AND pack_id = ? ORDER BY pack_offset`,
          source.id,
        );
        const pieces: Array<Uint8Array> = [];
        let at = bodyOffset;
        for (const row of rows) {
          if (row.pack_offset + row.zsize > bytes.length) {
            return yield* new StoreError({
              reason: `merge: ${row.oid} points past the end of wire pack ${source.id}`,
            });
          }
          const head = encodeTypeSize(row.type as PackEntryType, row.size);
          pieces.push(
            head,
            bytes.subarray(row.pack_offset, row.pack_offset + row.zsize),
          );
          rewrites.push({ oid: row.oid, offset: 12 + at + head.length });
          at += head.length + row.zsize;
        }
        const body = concatBytes(pieces);
        totalCount += rows.length;
        bodies.push(body);
        bodyOffset += body.length;
        continue;
      }
      if (
        bytes.length < 32 ||
        bytes[0] !== 0x50 ||
        bytes[1] !== 0x41 ||
        bytes[2] !== 0x43 ||
        bytes[3] !== 0x4b
      ) {
        return yield* new StoreError({
          reason: `merge: pack ${source.id} is not a packfile`,
        });
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      totalCount += view.getUint32(8);
      deltas.push({ id: source.id, delta: bodyOffset });
      const body = bytes.subarray(12, bytes.length - 20);
      bodies.push(body);
      bodyOffset += body.length;
    }
    const header = packHeader(totalCount);
    const trailer = yield* Effect.sync(() => {
      const hash = makeSha1();
      hash.update(header);
      for (const body of bodies) hash.update(body);
      return hash.digest();
    });
    const packId = yield* Effect.sync(() => bytesToHex(trailer));
    const merged = yield* Effect.sync(() => {
      const out = new Uint8Array(12 + bodyOffset + 20);
      out.set(header, 0);
      let at = 12;
      for (const body of bodies) {
        out.set(body, at);
        at += body.length;
      }
      out.set(trailer, at);
      return out;
    });

    const key = packKey(options.repoId, packId);
    yield* runR2(`merge put ${key}`)(
      options.blobs.put(key, merged, { contentLength: merged.length }),
    );

    // One additive UPDATE per source: new_offset = old_offset + delta
    // (old header and new header are both 12 bytes, so they cancel).
    let moved = 0;
    yield* options.sql
      .transactionSync((raw) => {
        for (const { id, delta } of deltas) {
          raw.exec(
            `UPDATE objects
                SET pack_id = ?, pack_offset = pack_offset + ?
              WHERE location = 'pack' AND pack_id = ?`,
            packId,
            delta,
            id,
          );
        }
        for (const { oid, offset } of rewrites) {
          raw.exec(
            `UPDATE objects SET pack_id = ?, pack_offset = ? WHERE oid = ?`,
            packId,
            offset,
            oid,
          );
        }
      })
      .pipe(Effect.asVoid);
    moved = sources.reduce((sum, source) => sum + source.count, 0);

    return {
      packs: sources.length,
      moved,
      bytes: merged.length,
      packId,
      pendingDelete: sources.map((source) =>
        packKeyOf(options.repoId, source.id),
      ),
      more,
    };
  });
