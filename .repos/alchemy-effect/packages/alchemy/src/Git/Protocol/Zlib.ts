/**
 * The zlib boundary — the ONLY module in `src/Git/Protocol/` allowed to touch
 * `node:zlib` (per DESIGN §7).
 *
 * | Need                                          | Tool                          |
 * |-----------------------------------------------|-------------------------------|
 * | Pack entry parsing (unknown compressed span)  | `createInflate()` per entry   |
 * | One-shot inflate of an exactly-known span     | `inflateSync`                 |
 * | Compression at rest (delta-resolved objects)  | `deflateSync` (level 6)       |
 *
 * The streaming-inflate trick (workerd-verified on 1.20260801.1): each pack
 * entry's zlib stream (RFC 1950) is self-terminating; `createInflate()`'s
 * `end` event fires at `Z_STREAM_END` mid-`write` without `.end()`, and
 * `inflate.bytesWritten` then reports the **exact compressed bytes
 * consumed** — the only way to find the next entry.
 * `DecompressionStream("deflate")` is disqualified for this: it errors on
 * trailing bytes and does not report consumption.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import zlib from "node:zlib";

/**
 * Error raised on zlib failures: corrupt streams, truncated input, or an
 * inflated output exceeding the caller's cap.
 */
export class ZlibError extends Schema.TaggedError<ZlibError>()("ZlibError", {
  reason: Schema.String,
}) {}

/**
 * The result of inflating one pack entry: the inflated content and the exact
 * number of compressed bytes consumed from the input (which locates the next
 * entry).
 */
export interface InflatedEntry {
  readonly content: Uint8Array;
  readonly bytesConsumed: number;
}

/** Feed granularity for the streaming inflater. */
const CHUNK = 65536;

/**
 * Streaming-inflates exactly one zlib stream from `buf` starting at
 * `offset`, tolerating arbitrary trailing bytes (the next pack entries).
 *
 * Input is fed in 64 KiB chunks; when the stream reaches `Z_STREAM_END` the
 * `end` event fires and `bytesWritten` gives the exact compressed span.
 * Truncated input (no `Z_STREAM_END` before the buffer ends) and corrupt
 * streams fail with {@link ZlibError}, as does output growing past
 * `options.maxOutput`.
 */
/**
 * Synchronous single-entry inflate — the fast path.
 *
 * The streaming implementation below builds a `zlib.createInflate()`
 * Transform (EventEmitter, internal buffers) and takes an async event-loop
 * round trip **per object**. Measured on a 13.7k-object push: ~1.49 ms of
 * CPU per object, roughly 50x the cost of actually inflating ~2.7 KB.
 *
 * `_processChunk` is what Node's own `zlib.inflateSync` uses internally: it
 * drives the engine synchronously and leaves the consumed-input count in
 * `bytesWritten`, which is exactly the pair a pack parser needs. It is an
 * internal API, so this returns `undefined` when it is unavailable (or
 * behaves unexpectedly) and the caller falls back to the stream path —
 * notably relevant on workerd, whose `node:zlib` is a compatibility shim.
 */
/**
 * Second synchronous path, on the PUBLIC API: `inflateSync(.., { info: true })`
 * returns `{ buffer, engine }`, and `engine.bytesWritten` is the input
 * consumed — the same pair `_processChunk` gives, without the internal.
 * zlib stops at the deflate stream's end, so trailing pack bytes are
 * ignored. Same `expectedSize` verification as above (a shim that returns
 * only a first chunk is caught by it). `undefined` = use the stream path.
 */
const inflateEntryInfoSync = (
  buf: Uint8Array,
  offset: number,
  maxOutput: number | undefined,
  expectedSize: number | undefined,
): InflatedEntry | undefined => {
  try {
    const result = zlib.inflateSync(buf.subarray(offset), {
      info: true,
    } as zlib.ZlibOptions) as unknown as {
      buffer?: Uint8Array;
      engine?: { bytesWritten?: number };
    };
    const output = result?.buffer;
    const bytesConsumed = result?.engine?.bytesWritten;
    if (
      output === undefined ||
      typeof bytesConsumed !== "number" ||
      bytesConsumed <= 0 ||
      (maxOutput !== undefined && output.length > maxOutput) ||
      (expectedSize !== undefined && output.length !== expectedSize)
    ) {
      return undefined;
    }
    return {
      content: new Uint8Array(output.buffer, output.byteOffset, output.length),
      bytesConsumed,
    };
  } catch {
    return undefined;
  }
};

const inflateEntryUnsafeSync = (
  buf: Uint8Array,
  offset: number,
  maxOutput: number | undefined,
  expectedSize: number | undefined,
): InflatedEntry | undefined => {
  const engine = zlib.createInflate() as unknown as {
    _processChunk?: (chunk: Uint8Array, flushFlag: number) => Uint8Array;
    bytesWritten?: number;
    close?: () => void;
  };
  if (typeof engine._processChunk !== "function") {
    engine.close?.();
    return inflateEntryInfoSync(buf, offset, maxOutput, expectedSize);
  }
  try {
    const output = engine._processChunk(
      buf.subarray(offset),
      zlib.constants.Z_SYNC_FLUSH,
    );
    const bytesConsumed = engine.bytesWritten;
    if (typeof bytesConsumed !== "number" || bytesConsumed <= 0) {
      return undefined;
    }
    if (maxOutput !== undefined && output.length > maxOutput) {
      // Let the caller's streaming path produce the typed error.
      return undefined;
    }
    // MUST verify: workerd's `node:zlib` shim returns only the first chunk
    // (observed: 525,107 bytes of a 1,337,267-byte object) instead of
    // looping like Node's implementation, and reports a plausible
    // `bytesWritten` with it. Checking against the size the pack header
    // already declares turns that silent truncation into a fallback.
    if (expectedSize !== undefined && output.length !== expectedSize) {
      // workerd's shim returned only the first output chunk: the public
      // `inflateSync({ info })` loops to completion — try it before paying
      // for the streaming path (measured: the entries that hit this were
      // the only async work left in a production ingest).
      return inflateEntryInfoSync(buf, offset, maxOutput, expectedSize);
    }
    return {
      content: new Uint8Array(output.buffer, output.byteOffset, output.length),
      bytesConsumed,
    };
  } catch {
    // Corrupt stream, truncated window, or an unsupported shim — the
    // stream path re-runs it and reports the real error.
    return undefined;
  } finally {
    engine.close?.();
  }
};

/**
 * The synchronous fast path alone (DESIGN §22.5): the exact-span inflate
 * when the whole compressed stream lies within `buf` and the platform
 * offers a sync engine; `undefined` means "use {@link inflateEntry}".
 */
export const inflateEntrySync = (
  buf: Uint8Array,
  offset: number,
  options: {
    readonly maxOutput?: number | undefined;
    readonly expectedSize: number;
  },
): InflatedEntry | undefined =>
  offset >= 0 && offset < buf.length
    ? inflateEntryUnsafeSync(
        buf,
        offset,
        options.maxOutput,
        options.expectedSize,
      )
    : undefined;

export const inflateEntry = (
  buf: Uint8Array,
  offset: number,
  options?: {
    readonly maxOutput?: number | undefined;
    /**
     * The uncompressed size the pack header declares for this entry. Used
     * to validate the synchronous fast path (see above); without it the
     * fast path is skipped, because an unverified result cannot be trusted.
     */
    readonly expectedSize?: number | undefined;
  },
): Effect.Effect<InflatedEntry, ZlibError> =>
  Effect.suspend(() => {
    const fast =
      offset >= 0 && offset < buf.length && options?.expectedSize !== undefined
        ? inflateEntryUnsafeSync(
            buf,
            offset,
            options.maxOutput,
            options.expectedSize,
          )
        : undefined;
    return fast === undefined
      ? inflateEntryStreaming(buf, offset, options)
      : Effect.succeed(fast);
  });

/** The portable fallback: a real zlib stream per entry. */
const inflateEntryStreaming = (
  buf: Uint8Array,
  offset: number,
  options?: { readonly maxOutput?: number | undefined },
): Effect.Effect<InflatedEntry, ZlibError> =>
  Effect.callback<InflatedEntry, ZlibError>((resume) => {
    if (offset < 0 || offset >= buf.length) {
      resume(
        Effect.fail(
          new ZlibError({
            reason: `inflate offset ${offset} out of range (buffer ${buf.length})`,
          }),
        ),
      );
      return;
    }
    const maxOutput = options?.maxOutput;
    const inflater = zlib.createInflate();
    const chunks: Array<Uint8Array> = [];
    let outBytes = 0;
    let settled = false;

    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      resume(Effect.fail(new ZlibError({ reason })));
    };

    inflater.on("data", (chunk: Uint8Array) => {
      if (settled) return;
      outBytes += chunk.length;
      if (maxOutput !== undefined && outBytes > maxOutput) {
        fail(`inflated output exceeds ${maxOutput} bytes`);
        return;
      }
      chunks.push(chunk);
    });
    inflater.on("error", (error: Error) => {
      fail(`inflate failed at offset ${offset}: ${error.message}`);
    });
    inflater.once("end", () => {
      if (settled) return;
      settled = true;
      const bytesConsumed = inflater.bytesWritten;
      const content = new Uint8Array(outBytes);
      let pos = 0;
      for (const chunk of chunks) {
        content.set(chunk, pos);
        pos += chunk.length;
      }
      inflater.destroy();
      resume(Effect.succeed({ content, bytesConsumed }));
    });

    const end = buf.length;
    let pos = offset;
    const feed = (): void => {
      if (settled) return;
      if (pos >= end) {
        // ran out of input without Z_STREAM_END — flushing EOF surfaces the
        // "unexpected end of file" error through the error handler above.
        inflater.end();
        return;
      }
      const next = Math.min(pos + CHUNK, end);
      const chunk = buf.subarray(pos, next);
      pos = next;
      inflater.write(chunk, () => feed());
    };
    feed();

    return Effect.sync(() => {
      // interruption: tear the native stream down
      if (!settled) {
        settled = true;
        inflater.destroy();
      }
    });
  });

/**
 * One-shot inflate of an exactly-known zlib span (e.g. a stored `zdata`
 * BLOB). Strict: trailing garbage or truncation fails.
 */
export const inflate = (
  data: Uint8Array,
): Effect.Effect<Uint8Array, ZlibError> =>
  Effect.try({
    try: () => new Uint8Array(zlib.inflateSync(data)),
    catch: (error) =>
      new ZlibError({
        reason: `inflateSync failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

/**
 * One-shot deflate at the given level (default 6 — the at-rest compression
 * level for delta-resolved objects; non-delta pack entries are stored
 * verbatim and never re-compressed).
 */
export const deflate = (
  data: Uint8Array,
  level = 6,
): Effect.Effect<Uint8Array, ZlibError> =>
  Effect.try({
    try: () => new Uint8Array(zlib.deflateSync(data, { level })),
    catch: (error) =>
      new ZlibError({
        reason: `deflateSync failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

/**
 * Inflates a COMPLETE deflate stream whose exact span is known (DESIGN
 * §22.8): the plain one-shot `inflateSync`, measured ~4x cheaper than the
 * consumed-count paths on production. Verified against the declared size.
 */
export const inflateExactSpan = (
  span: Uint8Array,
  expectedSize: number,
): Effect.Effect<Uint8Array, ZlibError> =>
  Effect.try({
    try: () => {
      const out = new Uint8Array(zlib.inflateSync(span));
      if (out.length !== expectedSize) {
        throw new Error(
          `inflated ${out.length} bytes, expected ${expectedSize}`,
        );
      }
      return out;
    },
    catch: (error) =>
      new ZlibError({
        reason: `inflateSync failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });
