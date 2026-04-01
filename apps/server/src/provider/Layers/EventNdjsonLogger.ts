/**
 * Provider event logger helper.
 *
 * Best-effort writer for observability logs. Each record is formatted as a
 * single effect-style text line in a thread-scoped file. Failures are
 * downgraded to warnings so provider runtime behavior is unaffected.
 */
import fs from "node:fs";
import path from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { Effect, Exit, Logger, Scope } from "effect";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 200;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export interface EventNdjsonLoggerOptions {
  readonly stream: EventNdjsonStream;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
}

interface ThreadWriter {
  writeMessage: (message: string) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function formatLoggerMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
  }
  return typeof message === "string" ? message : String(message);
}

function makeLineLogger(streamLabel: string): Logger.Logger<unknown, string> {
  return Logger.make(
    ({ date, message }) =>
      `[${date.toISOString()}] ${streamLabel}: ${formatLoggerMessage(message)}\n`,
  );
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  switch (stream) {
    case "native":
      return "NTIVE";
    case "canonical":
    case "orchestration":
    default:
      return "CANON";
  }
}

const toLogMessage = Effect.fn("toLogMessage")(function* (
  event: unknown,
): Effect.fn.Return<string | undefined> {
  const serialized = yield* Effect.sync(() => {
    try {
      return { ok: true as const, value: JSON.stringify(event) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });

  if (!serialized.ok) {
    yield* logWarning("failed to serialize provider event log record", {
      error: serialized.error,
    });
    return undefined;
  }

  if (typeof serialized.value !== "string") {
    return undefined;
  }

  return serialized.value;
});

const makeThreadWriter = Effect.fn("makeThreadWriter")(function* (input: {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly streamLabel: string;
}): Effect.fn.Return<ThreadWriter | undefined> {
  const sinkResult = yield* Effect.sync(() => {
    try {
      return {
        ok: true as const,
        sink: new RotatingFileSink({
          filePath: input.filePath,
          maxBytes: input.maxBytes,
          maxFiles: input.maxFiles,
          throwOnError: true,
        }),
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  });

  if (!sinkResult.ok) {
    yield* logWarning("failed to initialize provider thread log file", {
      filePath: input.filePath,
      error: sinkResult.error,
    });
    return undefined;
  }

  const sink = sinkResult.sink;
  const scope = yield* Scope.make();
  const lineLogger = makeLineLogger(input.streamLabel);
  const batchedLogger = yield* Logger.batched(lineLogger, {
    window: input.batchWindowMs,
    flush: Effect.fn("makeThreadWriter.flush")(function* (messages) {
      const flushResult = yield* Effect.sync(() => {
        try {
          for (const message of messages) {
            sink.write(message);
          }
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error };
        }
      });

      if (!flushResult.ok) {
        yield* logWarning("provider event log batch flush failed", {
          filePath: input.filePath,
          error: flushResult.error,
        });
      }
    }),
  }).pipe(Effect.provideService(Scope.Scope, scope));

  const loggerLayer = Logger.layer([batchedLogger], { mergeWithExisting: false });

  return {
    writeMessage(message: string) {
      return Effect.log(message).pipe(Effect.provide(loggerLayer));
    },
    close() {
      return Scope.close(scope, Exit.void);
    },
  } satisfies ThreadWriter;
});

export const makeEventNdjsonLogger = Effect.fn("makeEventNdjsonLogger")(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const streamLabel = resolveStreamLabel(options.stream);

  const directoryReady = yield* Effect.sync(() => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      return true;
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (directoryReady !== true) {
    yield* logWarning("failed to create provider event log directory", {
      filePath,
      error: directoryReady.error,
    });
    return undefined;
  }

  const threadWriters = new Map<string, ThreadWriter>();
  const failedSegments = new Set<string>();

  const resolveThreadWriter = Effect.fn("resolveThreadWriter")(function* (
    threadSegment: string,
  ): Effect.fn.Return<ThreadWriter | undefined> {
    if (failedSegments.has(threadSegment)) {
      return undefined;
    }
    const existing = threadWriters.get(threadSegment);
    if (existing) {
      return existing;
    }

    const writer = yield* makeThreadWriter({
      filePath: path.join(path.dirname(filePath), `${threadSegment}.log`),
      maxBytes,
      maxFiles,
      batchWindowMs,
      streamLabel,
    });
    if (!writer) {
      failedSegments.add(threadSegment);
      return undefined;
    }

    threadWriters.set(threadSegment, writer);
    return writer;
  });

  const write = Effect.fn("write")(function* (event: unknown, threadId: ThreadId | null) {
    const threadSegment = resolveThreadSegment(threadId);
    const message = yield* toLogMessage(event);
    if (!message) {
      return;
    }

    const writer = yield* resolveThreadWriter(threadSegment);
    if (!writer) {
      return;
    }

    yield* writer.writeMessage(message);
  });

  const close = Effect.fn("close")(function* () {
    for (const writer of threadWriters.values()) {
      yield* writer.close();
    }
    threadWriters.clear();
  });

  return {
    filePath,
    write,
    close,
  } satisfies EventNdjsonLogger;
});
