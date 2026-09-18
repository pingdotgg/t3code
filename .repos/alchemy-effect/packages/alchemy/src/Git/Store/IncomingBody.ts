/**
 * Receiving a git wire request body (DESIGN.md §3.6, §22.6, §22.10).
 *
 * A push body must NEVER be materialized: `request.arrayBuffer` on a
 * 100 MiB pack inside a 128 MB isolate is an OOM (the failure that rejected
 * the full alchemy-history push with a 500). The body is fed chunk by
 * chunk into a {@link StreamingFeeder} the parser reads from as bytes
 * arrive; the parser ends the body's life in memory by dispatching it in
 * uniform parts to the hasher isolates, which write the parts to blob
 * storage (the spill) while verifying them.
 *
 * The command section of a receive-pack request lives in the first bytes,
 * so the first {@link HEAD_BYTES} are enough to parse the ref commands
 * before the pack has arrived.
 */
import * as Effect from "effect/Effect";
import { StoreError } from "../Protocol/Store.ts";
import type { StreamingFeeder } from "./StreamingSource.ts";

/** Head prefix that is enough for command-section parsing. */
export const HEAD_BYTES = 1024 * 1024;

/**
 * Uniform multipart part size — also the hasher part size, since each
 * hasher isolate writes the part it verifies (DESIGN §22.10). 8 MiB is
 * above R2's 5 MiB minimum and its 10,000-part limit still allows ~78 GiB.
 */
export const SPILL_PART_BYTES = 8 * 1024 * 1024;

/**
 * Feeds a request body into the streaming source and ends it when the
 * body ends. The reader respects feeder backpressure while application
 * authorization or validation is running, and cancellation cancels the
 * underlying body reader. Resolves with the total; a read failure
 * fails the feeder so every waiting reader wakes with the error.
 */
export const feedBody = (
  body: ReadableStream<Uint8Array> | null,
  feeder: StreamingFeeder,
): Effect.Effect<{ readonly total: number }, StoreError> =>
  Effect.tryPromise({
    try: async (signal) => {
      let total = 0;
      if (body !== null) {
        const reader = body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.length;
            await Effect.runPromise(feeder.push(value), { signal });
          }
        } finally {
          signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
      }
      feeder.end();
      return { total };
    },
    catch: (error) =>
      new StoreError({ reason: `incoming body read: ${String(error)}` }),
  }).pipe(Effect.tapError((error) => Effect.sync(() => feeder.fail(error))));
