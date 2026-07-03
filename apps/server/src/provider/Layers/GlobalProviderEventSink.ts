/**
 * GlobalProviderEventSink - single consolidated NDJSON stream for all
 * provider events across all threads.
 *
 * `EventNdjsonLogger` fans events out into one file per thread
 * (`logs/provider/<threadId>.log`), which is great for following a single
 * thread but painful to search across all of them (this codebase can
 * easily accumulate hundreds of thread files). This sink additionally
 * appends every native/canonical event - tagged with its stream and
 * thread id - to a single rotated `provider-events.ndjson` file so the
 * whole provider runtime can be grepped/`jq`'d in one place.
 *
 * Mirrors `TraceSink`'s buffered-write + periodic-flush pattern, and
 * reuses the same `RotatingFileSink` rotation semantics as every other log
 * file (trace file, per-thread provider event files, server log file).
 */
import type { ThreadId } from "@t3tools/contracts";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { Effect } from "effect";

import type { EventNdjsonStream } from "./EventNdjsonLogger.ts";

const FLUSH_BUFFER_THRESHOLD = 32;

export interface GlobalProviderEventSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
}

export interface GlobalProviderEventSink {
  readonly filePath: string;
  push: (stream: EventNdjsonStream, threadId: ThreadId | null, event: unknown) => void;
  flush: Effect.Effect<void>;
}

export const makeGlobalProviderEventSink = Effect.fn("makeGlobalProviderEventSink")(function* (
  options: GlobalProviderEventSinkOptions,
) {
  const sink = new RotatingFileSink({
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
  });

  let buffer: Array<string> = [];

  const flushUnsafe = () => {
    if (buffer.length === 0) {
      return;
    }

    const chunk = buffer.join("");
    buffer = [];

    try {
      sink.write(chunk);
    } catch {
      buffer.unshift(chunk);
    }
  };

  const flush = Effect.sync(flushUnsafe).pipe(Effect.withTracerEnabled(false));

  yield* Effect.addFinalizer(() => flush.pipe(Effect.ignore));
  yield* Effect.forkScoped(
    Effect.sleep(`${options.batchWindowMs} millis`).pipe(Effect.andThen(flush), Effect.forever),
  );

  return {
    filePath: options.filePath,
    push(stream, threadId, event) {
      try {
        const line = {
          observedAt: new Date().toISOString(),
          stream,
          threadId: threadId ?? null,
          event,
        };
        buffer.push(`${JSON.stringify(line)}\n`);
        if (buffer.length >= FLUSH_BUFFER_THRESHOLD) {
          flushUnsafe();
        }
      } catch {
        return;
      }
    },
    flush,
  } satisfies GlobalProviderEventSink;
});
