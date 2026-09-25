/**
 * A pack source the parser can read WHILE the body is still arriving
 * (DESIGN §22.6). The receive-pack handler feeds request chunks in; the
 * parser reads forward through it; nothing waits for the upload to end.
 *
 * - Chunks are coalesced into fixed slabs (`SLAB_BYTES`), so a read inside
 *   one slab is a view (the parser's synchronous fast path needs views).
 * - A read past what has arrived blocks until enough bytes exist or the
 *   body ends; a read that cannot be satisfied at end returns short.
 * - Retention is bounded: once the parser has consumed past a slab and the
 *   retained total exceeds `retainBytes`, the oldest slab is dropped. A
 *   later read below the retained window (a delta base far behind) is
 *   served by the `fallback` reader — the spilled object, readable once the
 *   body has ended — or fails when there is none.
 * - Backpressure: `push` waits while more than `backpressureBytes` of
 *   unconsumed bytes are buffered, so a slow parser throttles the upload
 *   instead of growing memory.
 */
import * as Effect from "effect/Effect";
import { StoreError } from "../Protocol/Store.ts";
import type { RandomAccess } from "../Protocol/PackParser.ts";

// Slabs match the pump's part size so a part read is a view, not a copy.
export const SLAB_BYTES = 8 * 1024 * 1024;
export const RETAIN_BYTES = 16 * 1024 * 1024;
export const BACKPRESSURE_BYTES = 24 * 1024 * 1024;
// 24 MiB (was 8): the hasher chain runs behind the upload; with less room
// ahead of the pump the upload stalled on every part (DESIGN §22.7).

interface Slab {
  readonly start: number;
  readonly bytes: Uint8Array; // capacity SLAB_BYTES; `filled` bytes valid
  filled: number;
}

interface Waiter {
  readonly need: number;
  readonly resume: (result: Effect.Effect<void, StoreError>) => void;
}

export interface StreamingSource extends RandomAccess {
  /** Bytes received so far. */
  readonly received: () => number;
  /** Resolves with the total once the body has ended. */
  readonly awaitEnd: Effect.Effect<number, StoreError>;
  /** True once the feeder has ended the body. */
  readonly ended: () => boolean;
  /** The parser is done with everything below `offset`; retention may drop it. */
  readonly release: (offset: number) => void;
}

export interface StreamingFeeder {
  readonly source: StreamingSource;
  /** Appends a chunk; waits while backpressure applies. */
  readonly push: (chunk: Uint8Array) => Effect.Effect<void, StoreError>;
  /**
   * Appends without ever parking: for receivers whose consumer retains
   * the whole body anyway (the push pump, DESIGN §22.10), backpressure
   * buys nothing and the per-chunk Effect hop is the receive path's cost.
   * Returns false once the source has ended or failed.
   */
  readonly pushSync: (chunk: Uint8Array) => boolean;
  /** Ends the body; readers waiting past the end are woken. */
  readonly end: () => void;
  /**
   * Announces that a fallback reader WILL be set (the body is being
   * spilled): evicted reads after `end` wait for it instead of failing.
   */
  readonly expectFallback: () => void;
  /** Fails every current and future read. */
  readonly fail: (error: StoreError) => void;
  /**
   * Installs the reader for bytes that retention has dropped (the spilled
   * object). Reads below the retained window wait for it and for `end`.
   */
  readonly setFallback: (reader: RandomAccess) => void;
}

export const makeStreamingSource = (options?: {
  readonly retainBytes?: number | undefined;
  readonly backpressureBytes?: number | undefined;
  readonly slabBytes?: number | undefined;
}): StreamingFeeder => {
  const slabBytes = options?.slabBytes ?? SLAB_BYTES;
  const retainBytes = options?.retainBytes ?? RETAIN_BYTES;
  const backpressureBytes = options?.backpressureBytes ?? BACKPRESSURE_BYTES;
  const slabs: Array<Slab> = [];
  let received = 0;
  let retainFrom = 0; // first byte still in memory
  let consumed = 0; // parser's release watermark
  let ended = false;
  let total: number | undefined;
  let failure: StoreError | undefined;
  let fallback: RandomAccess | undefined;
  let fallbackExpected = false;
  const readWaiters: Array<Waiter> = [];
  const endWaiters: Array<(r: Effect.Effect<number, StoreError>) => void> = [];
  const pushWaiters: Array<() => void> = [];
  const fallbackWaiters: Array<() => void> = [];

  const append = (chunk: Uint8Array) => {
    let at = 0;
    while (at < chunk.length) {
      let slab = slabs[slabs.length - 1];
      if (slab === undefined || slab.filled === slab.bytes.length) {
        slab = { start: received, bytes: new Uint8Array(slabBytes), filled: 0 };
        slabs.push(slab);
      }
      const take = Math.min(chunk.length - at, slab.bytes.length - slab.filled);
      slab.bytes.set(chunk.subarray(at, at + take), slab.filled);
      slab.filled += take;
      received += take;
      at += take;
    }
  };
  const wake = () => {
    for (let i = readWaiters.length - 1; i >= 0; i--) {
      const w = readWaiters[i]!;
      if (failure !== undefined) {
        readWaiters.splice(i, 1);
        w.resume(Effect.fail(failure));
      } else if (received >= w.need || ended) {
        readWaiters.splice(i, 1);
        w.resume(Effect.void);
      }
    }
    if (ended || failure !== undefined) {
      const ws = endWaiters.splice(0);
      for (const w of ws) {
        w(
          failure !== undefined ? Effect.fail(failure) : Effect.succeed(total!),
        );
      }
    }
  };
  /**
   * Backpressure must never park the feeder while a reader is waiting for
   * bytes past the buffer — that reader is the only thing that will ever
   * consume, so parking would deadlock (a 64 KiB probe against a 1 KiB
   * budget, or an entry larger than the budget). A waiting reader always
   * releases the feeder.
   */
  const pushMayProceed = () =>
    received - consumed <= backpressureBytes ||
    readWaiters.length > 0 ||
    ended ||
    failure !== undefined;
  const wakePush = () => {
    if (pushMayProceed()) {
      const ws = pushWaiters.splice(0);
      for (const w of ws) w();
    }
  };
  const trim = () => {
    // Drop whole slabs entirely below the consumed watermark once the
    // retained total exceeds the budget.
    while (
      slabs.length > 1 &&
      received - retainFrom > retainBytes &&
      slabs[0]!.start + slabs[0]!.filled <= consumed
    ) {
      const dropped = slabs.shift()!;
      retainFrom = dropped.start + dropped.filled;
    }
  };
  const waitFor = (need: number): Effect.Effect<void, StoreError> =>
    Effect.suspend(() => {
      if (failure !== undefined) return Effect.fail(failure);
      if (received >= need || ended) return Effect.void;
      return Effect.callback<void, StoreError>((resume) => {
        readWaiters.push({ need, resume });
        wakePush(); // a waiting reader releases a parked feeder
      });
    });
  const waitForFallback: Effect.Effect<RandomAccess, StoreError> =
    Effect.suspend(() => {
      if (failure !== undefined) return Effect.fail(failure);
      if (fallback !== undefined && ended) return Effect.succeed(fallback);
      return Effect.callback<RandomAccess, StoreError>((resume) => {
        fallbackWaiters.push(() => {
          resume(
            failure !== undefined
              ? Effect.fail(failure)
              : fallback !== undefined
                ? Effect.succeed(fallback)
                : Effect.fail(
                    new StoreError({
                      reason:
                        "streaming source: bytes evicted and no fallback reader",
                    }),
                  ),
          );
        });
      });
    });
  const wakeFallback = () => {
    // Once the body has ended, evicted reads either get the fallback reader
    // or fail — they must never wait forever. When a fallback is expected
    // (the spill completes after the body ends), they wait for it.
    if (
      ended &&
      (fallback !== undefined || !fallbackExpected || failure !== undefined)
    ) {
      const ws = fallbackWaiters.splice(0);
      for (const w of ws) w();
    }
  };

  /** Assembles [offset, end) from retained slabs; a view when in one slab. */
  const assemble = (offset: number, end: number): Uint8Array => {
    let first = -1;
    for (let i = 0; i < slabs.length; i++) {
      const s = slabs[i]!;
      if (offset >= s.start && offset < s.start + s.filled) {
        first = i;
        break;
      }
    }
    if (first < 0) return new Uint8Array(0);
    const s0 = slabs[first]!;
    if (end <= s0.start + s0.filled) {
      return s0.bytes.subarray(offset - s0.start, end - s0.start);
    }
    const out = new Uint8Array(end - offset);
    let written = 0;
    for (let i = first; i < slabs.length && offset + written < end; i++) {
      const s = slabs[i]!;
      const from = Math.max(offset, s.start) - s.start;
      const to = Math.min(end, s.start + s.filled) - s.start;
      if (to <= from) break;
      out.set(s.bytes.subarray(from, to), written);
      written += to - from;
    }
    return written === out.length ? out : out.subarray(0, written);
  };

  const source: StreamingSource = {
    get size() {
      return total ?? Number.POSITIVE_INFINITY;
    },
    received: () => received,
    ended: () => ended,
    awaitEnd: Effect.suspend(() => {
      if (failure !== undefined) return Effect.fail(failure);
      if (ended) return Effect.succeed(total!);
      return Effect.callback<number, StoreError>((resume) => {
        endWaiters.push(resume);
      });
    }),
    release: (offset) => {
      if (offset > consumed) {
        consumed = offset;
        trim();
        wakePush();
      }
    },
    readSync: (offset, length) => {
      if (offset < retainFrom) return undefined;
      const end = Math.min(offset + length, received);
      if (end <= offset) return ended ? new Uint8Array(0) : undefined;
      if (end < offset + length && !ended) return undefined;
      for (const s of slabs) {
        if (offset >= s.start && end <= s.start + s.filled) {
          return s.bytes.subarray(offset - s.start, end - s.start);
        }
      }
      return undefined;
    },
    evictedBeforeEnd: (offset) => offset < retainFrom && !ended,
    read: (offset, length) =>
      Effect.gen(function* () {
        if (offset < retainFrom) {
          const reader = yield* waitForFallback;
          return yield* reader.read(offset, length);
        }
        yield* waitFor(offset + length);
        if (offset < retainFrom) {
          const reader = yield* waitForFallback;
          return yield* reader.read(offset, length);
        }
        const end = Math.min(offset + length, received);
        return end <= offset ? new Uint8Array(0) : assemble(offset, end);
      }),
  };

  return {
    source,
    pushSync: (chunk) => {
      if (failure !== undefined || ended) return false;
      append(chunk);
      wake();
      return true;
    },
    push: (chunk) =>
      Effect.gen(function* () {
        if (failure !== undefined) return yield* Effect.fail(failure);
        if (ended) {
          return yield* Effect.fail(
            new StoreError({ reason: "streaming source: push after end" }),
          );
        }
        append(chunk);
        wake();
        if (!pushMayProceed()) {
          yield* Effect.callback<void>((resume) => {
            pushWaiters.push(() => resume(Effect.void));
          });
        }
      }),
    expectFallback: () => {
      fallbackExpected = true;
    },
    end: () => {
      if (ended) return;
      ended = true;
      total = received;
      wake();
      wakePush();
      wakeFallback();
    },
    fail: (error) => {
      if (failure !== undefined) return;
      failure = error;
      ended = true;
      total ??= received;
      wake();
      wakePush();
      wakeFallback();
    },
    setFallback: (reader) => {
      fallback = reader;
      wakeFallback();
    },
  };
};
