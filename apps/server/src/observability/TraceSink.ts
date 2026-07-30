import { RotatingFileSink } from "@t3tools/shared/logging";
import { Effect } from "effect";

import type { TraceRecord } from "./TraceRecord.ts";

const FLUSH_BUFFER_THRESHOLD = 32;

export interface TraceSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
}

export interface TraceSink {
  readonly filePath: string;
  push: (record: TraceRecord) => void;
  flush: Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export const makeTraceSink = Effect.fn("makeTraceSink")(function* (options: TraceSinkOptions) {
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
    push(record) {
      try {
        buffer.push(`${JSON.stringify(record)}\n`);
        if (buffer.length >= FLUSH_BUFFER_THRESHOLD) {
          flushUnsafe();
        }
      } catch {
        return;
      }
    },
    flush,
    close: () => flush,
  } satisfies TraceSink;
});
