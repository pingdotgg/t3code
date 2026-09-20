/**
 * The concrete object store: DO SQLite rows + R2 overflow (DESIGN.md §3.3).
 *
 * Implements the git layer's `ObjectSource` contract over the `objects`
 * table, dispatching byte reads on the `location` column:
 *
 * - `'row'`  — the `zdata` BLOB (zlib(content), no loose header),
 * - `'r2'`   — a streamed R2 `get` of `r2_key` (which may point into a fork
 *   parent's prefix — immutable, shared),
 * - `'pack'` — v1.1 compaction; reads die with {@link NotImplementedError}
 *   until the compaction alarm lands (schema-ready, DESIGN.md §10).
 *
 * Plus the push-side surface the protocol layer needs: staged inserts with
 * the row/R2 placement policy, batched metadata reads, and the
 * staged-∪-live membership oracle behind the receive-pack connectivity
 * check (DESIGN.md §3.6 step 5).
 *
 * All reads on the `ObjectSource` surface see **live objects only**
 * (`staged_push IS NULL`); staged rows become visible to fetches only after
 * the final `transactionSync` flips them live.
 */
import type { BlobBody, BlobStoreError, BlobStoreShape } from "../BlobStore.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ObjectType, Oid } from "../Protocol/ObjectCodec.ts";
import {
  concatBytes,
  encodeTypeSize,
  type PackEntryType,
} from "../Protocol/ObjectCodec.ts";
import type { ManifestEntry } from "../Protocol/Store.ts";
import {
  StoreError,
  type ObjectLocation,
  type ObjectMeta,
  type ObjectSource,
} from "../Protocol/Store.ts";
import * as Zlib from "../Protocol/Zlib.ts";
import { objectKey, packKeyOf } from "./Keys.ts";
import type { ObjectMetaRow, SqlClient } from "./Sql.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compressed-size threshold above which an object's bytes are offloaded to
 * R2 (`location = 'r2'`) instead of a row BLOB — 1 MiB, a safety margin
 * under the 2 MB SQLite row cap (DESIGN.md §3.3).
 */
export const R2_OFFLOAD_THRESHOLD = 1_048_576;

/**
 * Per-object uncompressed size cap for v1 — 64 MiB. Delta application needs
 * base + result in memory; this keeps worst-case ingest memory bounded.
 * Enforced by `PackParser` (rejected with `unpack object too large`);
 * exported here as the storage layer's authoritative constant.
 */
export const MAX_OBJECT_SIZE = 67_108_864;

/**
 * Window size for coalesced reads out of compacted packs (DESIGN §15
 * bottleneck 2). Touching one object in a window fetches the whole window,
 * so a fetch that walks thousands of objects costs a handful of R2 GETs
 * instead of thousands.
 */
export const WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * Objects per batch on the emission/closure paths — one SQL statement and
 * one emitted chunk per batch instead of per object (DESIGN §22).
 */
export const EMIT_BATCH = 256;

/**
 * Rows per multi-row `INSERT` while staging a push: 6 bindings per row, and
 * Durable Object SQLite allows at most 100 bound parameters per statement
 * (`MAX_IN_PARAMS`) — 16 rows is 96. Still a 16x cut in statement
 * executions over one row per statement (see `insertStagedBatch`).
 */
export const STAGE_INSERT_ROWS = 16;

const chunkArray = <T>(
  items: ReadonlyArray<T>,
  size: number,
): Array<Array<T>> => {
  const out: Array<Array<T>> = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size) as Array<T>);
  }
  return out;
};

/**
 * Isolate-wide budget for retained pack windows — 32 MiB (8 windows).
 *
 * The cache is a module-level LRU shared by every repo instance in the
 * isolate, not a per-instance map: Durable Object instances of one class
 * share an isolate and its 128 MiB, so per-instance caches multiply with
 * the number of active repos. Measured (DESIGN §22.4): a 36 MiB push into a
 * second repo was rejected with "isolate exceeded its memory limit" while
 * the first repo's caches were resident. Keys carry the repo id
 * (`packKey`), so sharing is safe.
 */
export const WINDOW_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * Windows fetched ahead of the one being emitted (DESIGN §22.4). Blob
 * storage GETs cost ~150–250 ms each regardless of size, and a 40 MiB
 * pack is ten of them; fetched one at a time they were half of the
 * dynamic transfer time. 3 ahead + 1 current stays within the cache.
 */
export const PACK_LOOKAHEAD = 3;

const windows = new Map<string, { start: number; bytes: Uint8Array }>();
let windowBytes = 0;
const retainWindow = (
  cacheKey: string,
  slab: { start: number; bytes: Uint8Array },
) => {
  windows.set(cacheKey, slab);
  windowBytes += slab.bytes.byteLength;
  while (windowBytes > WINDOW_CACHE_BYTES && windows.size > 1) {
    const oldest = windows.keys().next().value;
    if (oldest === undefined) break;
    windowBytes -= windows.get(oldest)!.bytes.byteLength;
    windows.delete(oldest);
  }
};

/**
 * Raised (as a defect, via `Effect.die`) when a v1 code path reaches a
 * feature the design explicitly defers — currently only reads of
 * `location = 'pack'` objects, which exist starting with v1.1 compaction.
 */
export class NotImplementedError extends Schema.TaggedError<NotImplementedError>()(
  "NotImplementedError",
  { feature: Schema.String },
) {}

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A pack entry resolved by `PackParser`, ready to stage: the object id, its
 * numeric type, uncompressed size, and the zlib-compressed bytes to store
 * (the pack's compressed span verbatim for non-delta entries; a fresh
 * `deflate(content)` for delta-resolved ones).
 */
/**
 * The live-object predicate (DESIGN §22.14). A push's rows are live the
 * moment its `pushes` row is committed; the per-row `staged_push` column
 * is nulled afterwards, off the response path (`flipPush`), and by GC as a
 * safety net. Reads never wait for that rewrite.
 */
export const LIVE_OBJECTS =
  "(staged_push IS NULL OR staged_push IN (SELECT push_id FROM pushes WHERE state = 'committed'))";

export interface StagedObject {
  readonly oid: Oid;
  /**
   * Set when the bytes already live in a pack in blob storage (a promoted
   * wire pack, DESIGN §22.5): the row is staged as `location='pack'` with
   * these coordinates and `zdata` is NOT stored.
   */
  readonly pack?:
    | { readonly packId: string; readonly offset: number }
    | undefined;
  /**
   * Compressed span when `zdata` is not carried (a promoted row whose
   * bytes live in the pack): the insert must record the real size.
   */
  readonly zsize?: number | undefined;
  readonly type: ObjectType;
  /** Uncompressed content size in bytes. */
  readonly size: number;
  /** `zlib(content)` without the loose header. */
  readonly zdata: Uint8Array;
}

/** Outcome of {@link ObjectStore.insertStaged}. */
export type InsertOutcome = "inserted" | "exists";

/**
 * The full storage surface of a repo's objects: the read-only
 * `ObjectSource` the protocol layer consumes, plus batched metadata reads,
 * staged inserts, and the connectivity-check membership oracle.
 */
export interface ObjectStore extends ObjectSource {
  /**
   * Inflated content for many objects, one statement per ~256 oids — the
   * closure walk reads whole tree levels this way instead of one SQL
   * round trip per tree (DESIGN §22). Missing oids are simply absent.
   */
  readonly readContentBatch: (
    oids: ReadonlyArray<Oid>,
  ) => Effect.Effect<ReadonlyMap<Oid, Uint8Array>, StoreError>;
  readonly packEntries: (
    entries: ReadonlyArray<ManifestEntry>,
  ) => Stream.Stream<Uint8Array, StoreError>;
  /**
   * Batched metadata for many oids (live objects only). Chunked `IN`
   * queries, ≤ 100 params each. Missing oids are simply absent from the map.
   */
  readonly getMetaBatch: (
    oids: ReadonlyArray<Oid>,
  ) => Effect.Effect<ReadonlyMap<Oid, ObjectMeta>, StoreError>;
  /**
   * Stages one resolved object for `pushId` (DESIGN.md §3.6 step 4).
   *
   * Placement policy: compressed size > 1 MiB ⇒ the bytes are written to R2
   * **first** (`{repoId}/objects/{oid}`, content-addressed so re-runs are
   * idempotent), then the metadata row; otherwise the row carries the BLOB.
   *
   * Existing oids are skipped (idempotent re-push). A row left staged by a
   * **different** (crashed) push is adopted — re-stamped with this `pushId`
   * so the connectivity check and the final live-flip see it.
   */
  readonly insertStaged: (
    pushId: string,
    object: StagedObject,
  ) => Effect.Effect<InsertOutcome, StoreError>;
  /**
   * Batched sibling of {@link ObjectStore.insertStaged} — the ingest hot
   * path (DESIGN.md §16.6).
   *
   * Staging objects one at a time costs two statements each (an existence
   * probe and an insert), so a 13.7k-object push ran ~27k statements and
   * ~13.7k transactions inside a single-threaded Durable Object. This
   * inserts a whole batch in **one** `transactionSync` with
   * `INSERT OR IGNORE` (no probe), then adopts any rows left staged by a
   * crashed push with one chunked `UPDATE`.
   *
   * Oversize objects (> 1 MiB compressed) still go through the per-object
   * path, since each needs its own R2 write first.
   */
  readonly insertStagedBatch: (
    pushId: string,
    objects: ReadonlyArray<StagedObject>,
  ) => Effect.Effect<void, StoreError>;
  /** A live object's type and content for thin-delta resolution, or `undefined`. */
  /** Read only live objects or objects staged by this push, with a caller-selected size cap. */
  readonly readPrepared: (
    pushId: string,
    oid: Oid,
    maxBytes: number,
  ) => Effect.Effect<
    { readonly type: ObjectType; readonly content: Uint8Array } | undefined,
    StoreError
  >;
  readonly readBase: (
    oid: Oid,
  ) => Effect.Effect<
    { readonly type: ObjectType; readonly content: Uint8Array } | undefined,
    StoreError
  >;
  /**
   * The connectivity-check membership oracle: returns the subset of `oids`
   * that exist in **neither** the live store **nor** this push's staged
   * rows. An empty result means every referenced object is present and the
   * push is safe to commit.
   */
  readonly missingObjects: (
    oids: ReadonlyArray<Oid>,
    pushId: string,
  ) => Effect.Effect<ReadonlyArray<Oid>, StoreError>;
}

/**
 * Dependencies of {@link makeObjectStore}. Plain values (not Layers) so
 * `RepoObject.ts` wires the store inside its inner per-instance effect.
 */
export interface ObjectStoreOptions {
  /** The repo DO's SQL client (see `makeSqlClient`). */
  readonly sql: SqlClient;
  /** The swappable bulk-byte store (R2 by default — see `BlobStore.ts`). */
  readonly blobs: BlobStoreShape;
  /** The repo's ULID — the R2 key prefix (DESIGN.md §3.2). */
  readonly repoId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

const VALID_LOCATIONS: ReadonlySet<string> = new Set(["row", "r2", "pack"]);

const isObjectType = (type: number): type is ObjectType =>
  type === 1 || type === 2 || type === 3 || type === 4;

const metaFromRow = (
  row: ObjectMetaRow,
): Effect.Effect<ObjectMeta, StoreError> => {
  if (!isObjectType(row.type) || !VALID_LOCATIONS.has(row.location)) {
    return Effect.fail(
      new StoreError({
        reason: `corrupt objects row for ${row.oid}: type=${row.type} location=${row.location}`,
      }),
    );
  }
  return Effect.succeed({
    oid: row.oid,
    type: row.type,
    size: row.size,
    zsize: row.zsize,
    location: row.location as ObjectLocation,
  });
};

/**
 * Returns a plain `ArrayBuffer` view of the bytes for SQLite BLOB binding
 * (workerd binds `ArrayBuffer`, not typed arrays). Zero-copy when the view
 * spans its whole buffer.
 */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 &&
  bytes.byteLength === bytes.buffer.byteLength &&
  bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : (bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer);

/** Row projection used by the byte-read dispatch. */
interface ZDataRow extends Record<
  string,
  string | number | ArrayBuffer | null
> {
  readonly oid: string;
  readonly location: string;
  readonly zdata: ArrayBuffer | null;
  readonly r2_key: string | null;
  /** sha1 of the containing pack when `location='pack'` (DESIGN §12.1). */
  readonly pack_id: string | null;
  /** Byte offset of this object's zdata span inside that pack. */
  readonly pack_offset: number | null;
  /** Length of the zdata span (mirrors `zsize`). */
  readonly zsize: number;
}

/**
 * Creates the {@link ObjectStore} for one repo. Plain factory — no Layers —
 * so `RepoObject.ts` can wire it in its inner effect with the ambient
 * `state`/bucket handles.
 */
export const makeObjectStore = (options: ObjectStoreOptions): ObjectStore => {
  const { sql, blobs, repoId } = options;

  /** Discharges the blob store's `RuntimeContext` coloring and closes the
   * error union into `StoreError` (we run inside the Repo DO). */
  const runBlob = <A>(
    effect: Effect.Effect<A, BlobStoreError, RuntimeContext>,
    what: string,
  ): Effect.Effect<A, StoreError> =>
    effect.pipe(
      Effect.mapError(
        (error) => new StoreError({ reason: `${what}: ${error.reason}` }),
      ),
      Effect.provide(RuntimeContext.phantom),
    );

  const zlibToStore = (error: Zlib.ZlibError): StoreError =>
    new StoreError({ reason: error.reason });

  const readRow = (
    oid: Oid,
    pushId: string | null = null,
  ): Effect.Effect<ZDataRow | undefined, StoreError> =>
    sql.first<ZDataRow>(
      `SELECT oid, location, zdata, r2_key, pack_id, pack_offset, zsize
         FROM objects WHERE oid = ? AND (${LIVE_OBJECTS} OR staged_push = ?)`,
      oid,
      pushId,
    );

  const requireRow = Effect.fn(function* (
    oid: Oid,
    pushId: string | null = null,
  ) {
    const row = yield* readRow(oid, pushId);
    if (row === undefined) {
      return yield* Effect.fail(
        new StoreError({ reason: `object not found: ${oid}` }),
      );
    }
    return row;
  });

  /** Fetches the R2 body for an `'r2'`-located row. */
  const r2Body = Effect.fn(function* (oid: Oid, r2Key: string | null) {
    if (r2Key === null) {
      return yield* Effect.fail(
        new StoreError({
          reason: `object ${oid} has location='r2' but no r2_key`,
        }),
      );
    }
    const body = yield* runBlob(blobs.get(r2Key), `blob get ${r2Key}`);
    if (body === null) {
      return yield* Effect.fail(
        new StoreError({ reason: `R2 object missing: ${r2Key}` }),
      );
    }
    return body;
  });

  /**
   * Coalesced window cache over compacted packs (DESIGN §15 bottleneck 2).
   *
   * A pack read is one ranged R2 GET per object if done naively — and a
   * fetch that walks a few thousand objects then costs a few thousand
   * serialized round trips. Measured: **68 s to serve a 53 KiB fetch** over
   * a 1202-object pack. Instead, reads are served out of window-aligned
   * slabs: touching any object in a window fetches the whole window once,
   * and every other object inside it is then free. A small pack collapses
   * to a single GET.
   *
   * Bounded by construction: at most {@link MAX_CACHED_WINDOWS} windows of
   * {@link WINDOW_BYTES} are retained (insertion-ordered LRU), so the cache
   * cannot outgrow the isolate's memory budget.
   */

  const readWindow = Effect.fn(function* (key: string, windowIndex: number) {
    const cacheKey = `${key}:${windowIndex}`;
    const hit = windows.get(cacheKey);
    if (hit !== undefined) {
      // Refresh recency (Map iterates in insertion order).
      windows.delete(cacheKey);
      windows.set(cacheKey, hit);
      return hit;
    }
    const start = windowIndex * WINDOW_BYTES;
    const body = yield* runBlob(
      blobs.get(key, { offset: start, length: WINDOW_BYTES }),
      `blob window get ${key}`,
    );
    if (body === null) {
      return yield* Effect.fail(
        new StoreError({ reason: `pack missing: ${key}` }),
      );
    }
    const bytes = yield* body.bytes.pipe(
      Effect.mapError(
        (error) =>
          new StoreError({ reason: `R2 read ${key}: ${error.message}` }),
      ),
    );
    const slab = { start, bytes };
    retainWindow(cacheKey, slab);
    return slab;
  });

  /**
   * Reads an object's zdata span out of a compacted R2 pack (DESIGN §12.1),
   * via the window cache above.
   *
   * `pack_offset` addresses the object's **zdata** directly (not the pack
   * entry header), so the slice is exactly the stored compressed bytes —
   * the same bytes a `location='row'` object holds in its BLOB. Entry
   * headers are regenerated from `(type, size)` at emission time.
   */
  const packBytes = Effect.fn(function* (oid: Oid, row: ZDataRow) {
    if (row.pack_id === null || row.pack_offset === null) {
      return yield* Effect.fail(
        new StoreError({
          reason: `object ${oid} has location='pack' but no pack coordinates`,
        }),
      );
    }
    const key = packKeyOf(repoId, row.pack_id);
    const offset = row.pack_offset;
    const windowIndex = Math.floor(offset / WINDOW_BYTES);
    const slab = yield* readWindow(key, windowIndex);
    const relative = offset - slab.start;
    if (relative >= 0 && relative + row.zsize <= slab.bytes.length) {
      // Copy out: the slab is retained by the cache and must not be aliased.
      return slab.bytes.slice(relative, relative + row.zsize);
    }
    // The object straddles the window boundary (or the window was short) —
    // fall back to an exact ranged read for this one object.
    const body = yield* runBlob(
      blobs.get(key, { offset, length: row.zsize }),
      `blob ranged get ${key}`,
    );
    if (body === null) {
      return yield* Effect.fail(
        new StoreError({ reason: `pack missing: ${key}` }),
      );
    }
    return yield* body.bytes.pipe(
      Effect.mapError(
        (error) =>
          new StoreError({ reason: `R2 read ${key}: ${error.message}` }),
      ),
    );
  });

  /** Reads the stored compressed bytes fully into memory. */
  const readZBytes = Effect.fn(function* (
    oid: Oid,
    pushId: string | null = null,
  ) {
    const row = yield* requireRow(oid, pushId);
    switch (row.location) {
      case "row": {
        if (row.zdata === null) {
          return yield* Effect.fail(
            new StoreError({
              reason: `object ${oid} has location='row' but NULL zdata`,
            }),
          );
        }
        return new Uint8Array(row.zdata);
      }
      case "r2": {
        const body = yield* r2Body(oid, row.r2_key);
        return yield* body.bytes.pipe(
          Effect.mapError(
            (error) =>
              new StoreError({
                reason: `R2 read ${row.r2_key}: ${error.message}`,
              }),
          ),
        );
      }
      case "pack":
        return yield* packBytes(oid, row);
      default:
        return yield* Effect.fail(
          new StoreError({
            reason: `object ${oid} has unknown location '${row.location}'`,
          }),
        );
    }
  });

  const getMetaBatch = (
    oids: ReadonlyArray<Oid>,
  ): Effect.Effect<ReadonlyMap<Oid, ObjectMeta>, StoreError> =>
    Effect.gen(function* () {
      const unique = Array.from(new Set(oids));
      const map = new Map<Oid, ObjectMeta>();
      if (unique.length === 0) {
        return map;
      }
      const rows = yield* sql.inChunks<ObjectMetaRow>(
        (ph) =>
          `SELECT oid, type, size, zsize, location FROM objects WHERE oid IN (${ph}) AND ${LIVE_OBJECTS}`,
        unique,
      );
      for (const row of rows) {
        map.set(row.oid, yield* metaFromRow(row));
      }
      return map;
    });

  const insertStagedOne = Effect.fn(function* (
    pushId: string,
    object: StagedObject,
  ) {
    const existing = yield* sql.first<{ staged_push: string | null }>(
      `SELECT staged_push FROM objects WHERE oid = ?`,
      object.oid,
    );
    if (existing !== undefined) {
      if (existing.staged_push !== null && existing.staged_push !== pushId) {
        // Adopt a row left staged by a crashed push so this push's
        // connectivity check and live-flip see it.
        yield* sql.run(
          `UPDATE objects SET staged_push = ? WHERE oid = ? AND staged_push IS NOT NULL`,
          pushId,
          object.oid,
        );
      }
      return "exists" as const;
    }
    if (object.zdata.byteLength > R2_OFFLOAD_THRESHOLD) {
      // R2 write FIRST, then the metadata row — a crash between the two
      // leaves only a harmless content-addressed R2 orphan.
      const key = objectKey(repoId, object.oid);
      yield* runBlob(blobs.put(key, object.zdata), `blob put ${key}`);
      yield* sql.run(
        `INSERT OR IGNORE INTO objects (oid, type, size, zsize, location, zdata, r2_key, staged_push)
           VALUES (?, ?, ?, ?, 'r2', NULL, ?, ?)`,
        object.oid,
        object.type,
        object.size,
        object.zdata.byteLength,
        key,
        pushId,
      );
    } else {
      yield* sql.run(
        `INSERT OR IGNORE INTO objects (oid, type, size, zsize, location, zdata, staged_push)
           VALUES (?, ?, ?, ?, 'row', ?, ?)`,
        object.oid,
        object.type,
        object.size,
        object.zdata.byteLength,
        toArrayBuffer(object.zdata),
        pushId,
      );
    }
    return "inserted" as const;
  });

  const readZDataOf = (oid: Oid): Stream.Stream<Uint8Array, StoreError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const row = yield* requireRow(oid);
        switch (row.location) {
          case "row": {
            if (row.zdata === null) {
              return yield* Effect.fail(
                new StoreError({
                  reason: `object ${oid} has location='row' but NULL zdata`,
                }),
              );
            }
            return Stream.succeed(new Uint8Array(row.zdata));
          }
          case "r2": {
            const body = yield* r2Body(oid, row.r2_key);
            return body.stream.pipe(
              Stream.mapError(
                (error) =>
                  new StoreError({
                    reason: `R2 stream ${row.r2_key}: ${error.message}`,
                  }),
              ),
            );
          }
          case "pack":
            return Stream.succeed(yield* packBytes(oid, row));
          default:
            return yield* Effect.fail(
              new StoreError({
                reason: `object ${oid} has unknown location '${row.location}'`,
              }),
            );
        }
      }),
    );

  const self: ObjectStore = {
    // ── ObjectSource (live objects only) ────────────────────────────────────
    has: (oid) =>
      sql
        .first<{ one: number }>(
          `SELECT 1 AS one FROM objects WHERE oid = ? AND ${LIVE_OBJECTS}`,
          oid,
        )
        .pipe(Effect.map((row) => row !== undefined)),

    filterExisting: (oids) =>
      Effect.gen(function* () {
        const unique = Array.from(new Set(oids));
        if (unique.length === 0) {
          return [];
        }
        const rows = yield* sql.inChunks<{ oid: string }>(
          (ph) =>
            `SELECT oid FROM objects WHERE oid IN (${ph}) AND ${LIVE_OBJECTS}`,
          unique,
        );
        return rows.map((row) => row.oid);
      }),

    getMeta: (oid) =>
      Effect.gen(function* () {
        const row = yield* sql.first<ObjectMetaRow>(
          `SELECT oid, type, size, zsize, location FROM objects WHERE oid = ? AND ${LIVE_OBJECTS}`,
          oid,
        );
        if (row === undefined) {
          return undefined;
        }
        return yield* metaFromRow(row);
      }),

    readZData: readZDataOf,

    readContent: (oid) =>
      readZBytes(oid).pipe(
        Effect.flatMap((zdata) =>
          Zlib.inflate(zdata).pipe(Effect.mapError(zlibToStore)),
        ),
      ),

    readContentBatch: (oids) =>
      Effect.gen(function* () {
        const out = new Map<Oid, Uint8Array>();
        const unique = Array.from(new Set(oids));
        if (unique.length === 0) return out;
        const rows = yield* sql.inChunks<ZDataRow>(
          (ph) =>
            `SELECT oid, location, zdata, r2_key, pack_id, pack_offset, zsize
               FROM objects WHERE oid IN (${ph}) AND ${LIVE_OBJECTS}`,
          unique,
        );
        const inflate = (z: Uint8Array) =>
          Zlib.inflate(z).pipe(Effect.mapError(zlibToStore));
        // Pack-resident rows in pack order so consecutive window reads hit.
        const packRows = rows
          .filter((row) => row.location === "pack")
          .sort(
            (a, b) =>
              (a.pack_id ?? "").localeCompare(b.pack_id ?? "") ||
              (a.pack_offset ?? 0) - (b.pack_offset ?? 0),
          );
        for (const row of rows) {
          if (row.location === "row" && row.zdata !== null) {
            out.set(row.oid, yield* inflate(new Uint8Array(row.zdata)));
          } else if (row.location === "r2") {
            out.set(
              row.oid,
              yield* readZBytes(row.oid).pipe(Effect.flatMap(inflate)),
            );
          }
        }
        for (const row of packRows) {
          out.set(row.oid, yield* inflate(yield* packBytes(row.oid, row)));
        }
        return out;
      }),

    packEntries: (entries) =>
      Stream.suspend(() => {
        // Locality order (DESIGN §22): a non-delta pack is order-free, so
        // emit SQLite rows in manifest order, then every pack-resident
        // object sorted by (pack, offset) so the window cache streams each
        // 4 MiB window exactly once, then the rare R2-offloaded objects.
        const byOid = new Map(entries.map((entry) => [entry.oid, entry]));
        const rowEntries: Array<ManifestEntry> = [];
        const packList: Array<ManifestEntry> = [];
        const r2Entries: Array<ManifestEntry> = [];
        for (const entry of entries) {
          (entry.location === "row"
            ? rowEntries
            : entry.location === "pack"
              ? packList
              : r2Entries
          ).push(entry);
        }
        const header = (entry: ManifestEntry) =>
          encodeTypeSize(entry.type as PackEntryType, entry.size);

        const rowStream = Stream.fromIterable(
          chunkArray(rowEntries, EMIT_BATCH),
        ).pipe(
          Stream.mapEffect((run) =>
            Effect.gen(function* () {
              const rows = yield* sql.inChunks<{
                oid: string;
                zdata: ArrayBuffer | null;
              }>(
                (ph) =>
                  `SELECT oid, zdata FROM objects WHERE oid IN (${ph}) AND ${LIVE_OBJECTS}`,
                run.map((entry) => entry.oid),
              );
              const zdataOf = new Map(rows.map((row) => [row.oid, row.zdata]));
              const pieces: Array<Uint8Array> = [];
              for (const entry of run) {
                const zdata = zdataOf.get(entry.oid);
                if (zdata === undefined || zdata === null) {
                  // The manifest said 'row', but compaction may have moved
                  // the bytes to a pack between closure and emission (the
                  // alarm runs concurrently with fetches). Re-dispatch on
                  // the CURRENT location; only a truly absent object fails.
                  pieces.push(header(entry), yield* readZBytes(entry.oid));
                  continue;
                }
                pieces.push(header(entry), new Uint8Array(zdata));
              }
              return concatBytes(pieces);
            }),
          ),
        );

        // Pack runs (DESIGN §22.4): coords sorted by (pack, offset) and
        // grouped by 4 MiB window. Each group is ONE window fetch (with the
        // next window fetched concurrently — a cache hit on the following
        // step) and one synchronous slice loop: no per-object Effect call,
        // no per-object cache lookup. Objects that straddle a window edge
        // (rare) fall back to the ranged read in `packBytes`; pack order
        // is free, so they simply follow their window's run.
        const packStream = Stream.unwrap(
          Effect.gen(function* () {
            if (packList.length === 0) return Stream.empty;
            const coords = yield* sql.inChunks<{
              oid: string;
              pack_id: string | null;
              pack_offset: number | null;
              zsize: number;
            }>(
              (ph) =>
                `SELECT oid, pack_id, pack_offset, zsize FROM objects WHERE oid IN (${ph}) AND ${LIVE_OBJECTS}`,
              packList.map((entry) => entry.oid),
            );
            coords.sort(
              (a, b) =>
                (a.pack_id ?? "").localeCompare(b.pack_id ?? "") ||
                (a.pack_offset ?? 0) - (b.pack_offset ?? 0),
            );
            type Coord = (typeof coords)[number];
            type Run = {
              readonly key: string;
              readonly window: number;
              readonly inside: Array<Coord>;
              readonly straddling: Array<Coord>;
            };
            const runs: Array<Run> = [];
            for (const coord of coords) {
              if (coord.pack_id === null || coord.pack_offset === null) {
                return yield* Effect.fail(
                  new StoreError({
                    reason: `object ${coord.oid} is location='pack' without coordinates`,
                  }),
                );
              }
              const key = packKeyOf(repoId, coord.pack_id);
              const window = Math.floor(coord.pack_offset / WINDOW_BYTES);
              let run = runs[runs.length - 1];
              if (
                run === undefined ||
                run.key !== key ||
                run.window !== window
              ) {
                run = { key, window, inside: [], straddling: [] };
                runs.push(run);
              }
              (coord.pack_offset + coord.zsize <= (window + 1) * WINDOW_BYTES
                ? run.inside
                : run.straddling
              ).push(coord);
            }
            const rowOf = (coord: Coord): ZDataRow => ({
              oid: coord.oid,
              location: "pack",
              zdata: null,
              r2_key: null,
              pack_id: coord.pack_id,
              pack_offset: coord.pack_offset,
              zsize: coord.zsize,
            });
            // Lookahead: the next PACK_LOOKAHEAD windows are fetched
            // concurrently with this one; each is a cache hit when its
            // turn comes. Bounded by WINDOW_CACHE_BYTES (8 windows).
            return Stream.fromIterable(
              runs.map(
                (run, i) =>
                  [run, runs.slice(i + 1, i + 1 + PACK_LOOKAHEAD)] as const,
              ),
            ).pipe(
              Stream.mapEffect(([run, ahead]) =>
                Effect.gen(function* () {
                  const [slab] = yield* Effect.all(
                    [
                      readWindow(run.key, run.window),
                      ...ahead.map((next) =>
                        readWindow(next.key, next.window).pipe(Effect.ignore),
                      ),
                    ],
                    { concurrency: 1 + PACK_LOOKAHEAD },
                  );
                  const pieces = yield* Effect.sync(() => {
                    const out: Array<Uint8Array> = [];
                    for (const coord of run.inside) {
                      const entry = byOid.get(coord.oid);
                      if (entry === undefined) continue;
                      const at = coord.pack_offset! - slab.start;
                      out.push(
                        header(entry),
                        slab.bytes.subarray(at, at + coord.zsize),
                      );
                    }
                    return out;
                  });
                  for (const coord of run.straddling) {
                    const entry = byOid.get(coord.oid);
                    if (entry === undefined) continue;
                    pieces.push(
                      header(entry),
                      yield* packBytes(coord.oid, rowOf(coord)),
                    );
                  }
                  return concatBytes(pieces);
                }),
              ),
            );
          }),
        );

        const r2Stream = Stream.fromIterable(r2Entries).pipe(
          Stream.flatMap((entry) =>
            Stream.succeed(header(entry)).pipe(
              Stream.concat(readZDataOf(entry.oid)),
            ),
          ),
        );

        return rowStream.pipe(
          Stream.concat(packStream),
          Stream.concat(r2Stream),
        );
      }),

    // ── Store-side surface ──────────────────────────────────────────────────
    getMetaBatch,

    insertStagedBatch: Effect.fn(function* (
      pushId: string,
      objects: ReadonlyArray<StagedObject>,
    ) {
      if (objects.length === 0) return;
      const inline: Array<StagedObject> = [];
      const promoted: Array<StagedObject> = [];
      for (const object of objects) {
        if (object.pack !== undefined) {
          promoted.push(object);
        } else if (object.zdata.byteLength > R2_OFFLOAD_THRESHOLD) {
          yield* insertStagedOne(pushId, object);
        } else {
          inline.push(object);
        }
      }
      if (promoted.length > 0) {
        // Rows that point into a pack already in blob storage: no BLOB
        // written to SQLite at all. 7 bindings per row → 14 rows per
        // statement under the 100-parameter cap.
        const sorted = [...promoted].sort((a, b) =>
          a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0,
        );
        const written = yield* sql.transactionSync((raw) => {
          let changed = 0;
          for (let at = 0; at < sorted.length; at += 14) {
            const part = sorted.slice(at, at + 14);
            const values = part
              .map(() => "(?, ?, ?, ?, 'pack', NULL, ?, ?, ?)")
              .join(", ");
            const bindings: Array<string | number> = [];
            for (const object of part) {
              bindings.push(
                object.oid,
                object.type,
                object.size,
                object.zsize ?? object.zdata.byteLength,
                object.pack!.packId,
                object.pack!.offset,
                pushId,
              );
            }
            changed += raw.exec(
              `INSERT OR IGNORE INTO objects (oid, type, size, zsize, location, zdata, pack_id, pack_offset, staged_push) VALUES ${values}`,
              ...bindings,
            ).rowsWritten;
          }
          return changed;
        });
        if (written < sorted.length) {
          yield* sql.inChunks(
            (ph) =>
              `UPDATE objects SET staged_push = ? WHERE oid IN (${ph})
                 AND staged_push IS NOT NULL AND staged_push != ?
                 AND staged_push NOT IN (SELECT push_id FROM pushes WHERE state = 'committed')`,
            sorted.map((object) => object.oid),
            { prefix: [pushId], suffix: [pushId] },
          );
        }
      }
      if (inline.length === 0) return;

      // One transaction for the whole batch: `INSERT OR IGNORE` needs no
      // existence probe, and a single commit replaces one per object.
      // Sorted by oid: the table is WITHOUT ROWID keyed by oid, so inserting
      // in key order turns a batch into sequential B-tree appends instead of
      // random page splits.
      const rows = inline
        .map((object) => ({
          oid: object.oid,
          type: object.type,
          size: object.size,
          zsize: object.zdata.byteLength,
          zdata: toArrayBuffer(object.zdata),
        }))
        .sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
      // Multi-row INSERTs (DESIGN §22.4): one statement per STAGE_INSERT_ROWS
      // rows instead of one per row. On production CPU each statement
      // execution costs far more than binding six more parameters, and
      // staging was the largest slice of a push's ingest (7 s of 30 s).
      const written = yield* sql.transactionSync((raw) => {
        let changed = 0;
        for (let at = 0; at < rows.length; at += STAGE_INSERT_ROWS) {
          const part = rows.slice(at, at + STAGE_INSERT_ROWS);
          const values = part.map(() => "(?, ?, ?, ?, 'row', ?, ?)").join(", ");
          const bindings: Array<string | number | ArrayBuffer> = [];
          for (const row of part) {
            bindings.push(
              row.oid,
              row.type,
              row.size,
              row.zsize,
              row.zdata,
              pushId,
            );
          }
          const cursor = raw.exec(
            `INSERT OR IGNORE INTO objects (oid, type, size, zsize, location, zdata, staged_push) VALUES ${values}`,
            ...bindings,
          );
          changed += cursor.rowsWritten;
        }
        return changed;
      });
      // Every row was new: nothing to adopt. Only when INSERT OR IGNORE
      // skipped rows can some belong to a crashed push and need re-stamping.
      if (written >= rows.length) return;
      yield* sql.inChunks(
        (ph) =>
          `UPDATE objects SET staged_push = ? WHERE oid IN (${ph})
             AND staged_push IS NOT NULL AND staged_push != ?
             AND staged_push NOT IN (SELECT push_id FROM pushes WHERE state = 'committed')`,
        inline.map((object) => object.oid),
        { prefix: [pushId], suffix: [pushId] },
      );
    }),
    readPrepared: (pushId, oid, maxBytes) =>
      Effect.gen(function* () {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
          return yield* new StoreError({ reason: "invalid object size limit" });
        const row = yield* sql.first<ObjectMetaRow>(
          `SELECT oid, type, size, zsize, location FROM objects WHERE oid = ? AND (${LIVE_OBJECTS} OR staged_push = ?)`,
          oid,
          pushId,
        );
        if (row === undefined) return undefined;
        const meta = yield* metaFromRow(row);
        if (meta.size > maxBytes)
          return yield* new StoreError({
            reason: `object exceeds ${maxBytes} byte read limit`,
          });
        const zdata = yield* readZBytes(oid, pushId);
        const content = yield* Zlib.inflate(zdata).pipe(
          Effect.mapError(zlibToStore),
        );
        return { type: meta.type, content };
      }),

    readBase: (oid) =>
      self
        .getMeta(oid)
        .pipe(
          Effect.flatMap((meta) =>
            meta === undefined
              ? Effect.succeed(undefined)
              : self
                  .readContent(oid)
                  .pipe(
                    Effect.map((content) => ({ type: meta.type, content })),
                  ),
          ),
        ),
    insertStaged: insertStagedOne,

    missingObjects: (oids, pushId) =>
      Effect.gen(function* () {
        const unique = Array.from(new Set(oids));
        if (unique.length === 0) {
          return [];
        }
        const rows = yield* sql.inChunks<{ oid: string }>(
          (ph) =>
            `SELECT oid FROM objects WHERE oid IN (${ph}) AND (${LIVE_OBJECTS} OR staged_push = ?)`,
          unique,
          { suffix: [pushId] },
        );
        const present = new Set(rows.map((row) => row.oid));
        return unique.filter((oid) => !present.has(oid));
      }),
  };
  return self;
};
