/**
 * A {@link RandomAccess} over a blob-store object, for pack ingestion
 * (DESIGN.md §3.6 upgrade seam) — this is what removes the push size cap.
 *
 * v1 buffered the whole incoming pack in the isolate, which forced a hard
 * 50 MiB limit: a bigger push could not be held in 128 MB of memory
 * alongside delta bases. Instead the body is streamed to the blob store
 * and parsed *from there*, so ingest memory is bounded by the read window
 * rather than by the pack size. `PackParser` was written against
 * `RandomAccess` from the start precisely so this swap touches one
 * implementation and no protocol code.
 *
 * Reads are served from window-aligned slabs (the same technique the object
 * store uses for compacted packs): pack parsing is overwhelmingly
 * sequential, so one window fetch serves thousands of consecutive reads,
 * and the occasional backwards seek for an OFS_DELTA base usually lands in
 * a retained window too.
 */
import { RuntimeContext } from "../../RuntimeContext.ts";
import * as Effect from "effect/Effect";
import type { BlobStoreShape } from "../BlobStore.ts";
import type { RandomAccess } from "../Protocol/PackParser.ts";
import { StoreError } from "../Protocol/Store.ts";

/** Bytes fetched per window. */
export const PACK_WINDOW_BYTES = 4 * 1024 * 1024;

/** Windows retained (insertion-ordered LRU) — bounds ingest memory. */
export const PACK_MAX_WINDOWS = 4;

/**
 * Opens a blob-store object as a {@link RandomAccess}. `size` must be the
 * object's exact byte length (the caller knows it: it just uploaded it).
 */
export const blobRandomAccess = (options: {
  readonly blobs: BlobStoreShape;
  readonly key: string;
  readonly size: number;
  readonly windowBytes?: number | undefined;
  readonly maxWindows?: number | undefined;
}): RandomAccess => {
  const windowBytes = options.windowBytes ?? PACK_WINDOW_BYTES;
  const maxWindows = options.maxWindows ?? PACK_MAX_WINDOWS;
  const windows = new Map<number, { start: number; bytes: Uint8Array }>();

  const fetchWindow = (index: number) =>
    Effect.gen(function* () {
      const hit = windows.get(index);
      if (hit !== undefined) {
        windows.delete(index);
        windows.set(index, hit);
        return hit;
      }
      const start = index * windowBytes;
      const body = yield* options.blobs
        .get(options.key, { offset: start, length: windowBytes })
        .pipe(
          Effect.mapError(
            (error) =>
              new StoreError({
                reason: `incoming pack read ${options.key}: ${error.reason}`,
              }),
          ),
          Effect.provide(RuntimeContext.phantom),
        );
      if (body === null) {
        return yield* Effect.fail(
          new StoreError({ reason: `incoming pack missing: ${options.key}` }),
        );
      }
      const bytes = yield* body.bytes.pipe(
        Effect.mapError(
          (error) =>
            new StoreError({
              reason: `incoming pack read ${options.key}: ${error.reason}`,
            }),
        ),
      );
      const slab = { start, bytes };
      windows.set(index, slab);
      while (windows.size > maxWindows) {
        const oldest = windows.keys().next().value;
        if (oldest === undefined) break;
        windows.delete(oldest);
      }
      return slab;
    });

  return {
    size: options.size,
    awaitEnd: Effect.succeed(options.size),
    readSync: (offset, length) => {
      const end = Math.min(offset + length, options.size);
      if (end <= offset) return new Uint8Array(0);
      const first = Math.floor(offset / windowBytes);
      if (first !== Math.floor((end - 1) / windowBytes)) return undefined;
      const slab = windows.get(first);
      if (slab === undefined) return undefined;
      const from = offset - slab.start;
      return slab.bytes.subarray(from, from + (end - offset));
    },
    read: (offset, length) =>
      Effect.gen(function* () {
        const end = Math.min(offset + length, options.size);
        if (end <= offset) return new Uint8Array(0);
        const first = Math.floor(offset / windowBytes);
        const last = Math.floor((end - 1) / windowBytes);
        if (first === last) {
          // A VIEW, not a copy (DESIGN §22.4). The parser probes every
          // entry with a window-sized read and copies only what it keeps;
          // returning a slice here copied that probe window per entry —
          // 15k entries × the probe size — which on a spilled 40 MiB push
          // was the difference between ~6 s and ~40 s of ingest. The slab
          // stays alive as long as any view does, so eviction is safe.
          const slab = yield* fetchWindow(first);
          const from = offset - slab.start;
          return slab.bytes.subarray(from, from + (end - offset));
        }
        // A read spanning window boundaries: stitch the windows it covers.
        const out = new Uint8Array(end - offset);
        let written = 0;
        for (let index = first; index <= last; index++) {
          const slab = yield* fetchWindow(index);
          const chunkStart = Math.max(offset, slab.start);
          const chunkEnd = Math.min(end, slab.start + slab.bytes.length);
          if (chunkEnd <= chunkStart) continue;
          out.set(
            slab.bytes.subarray(chunkStart - slab.start, chunkEnd - slab.start),
            written,
          );
          written += chunkEnd - chunkStart;
        }
        return written === out.length ? out : out.subarray(0, written);
      }),
  };
};

/**
 * A view of `source` starting at `start` — used to address the pack that
 * follows the command section inside a spilled receive-pack body.
 */
export const sliceRandomAccess = (
  source: RandomAccess,
  start: number,
): RandomAccess => ({
  size: source.size - start,
  read: (offset, length) => source.read(start + offset, length),
  readSync:
    source.readSync === undefined
      ? undefined
      : (offset, length) => source.readSync!(start + offset, length),
  awaitEnd:
    source.awaitEnd === undefined
      ? undefined
      : source.awaitEnd.pipe(Effect.map((total) => total - start)),
  release:
    source.release === undefined
      ? undefined
      : (offset) => source.release!(start + offset),
});
