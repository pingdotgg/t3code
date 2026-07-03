import { RotatingFileSink } from "@t3tools/shared/logging";
import { Effect, Logger, References, Layer } from "effect";

import { ServerConfig } from "./config.ts";

const SERVER_LOG_MAX_BYTES = 10 * 1024 * 1024;
const SERVER_LOG_MAX_FILES = 10;
const SERVER_LOG_BATCH_WINDOW_MS = 200;

/**
 * Structured NDJSON logger persisted to `serverLogPath`, rotated with the
 * same `RotatingFileSink` used for trace and provider event files.
 * `Logger.formatJson` already serializes level/message/fiber/spans and
 * (via `Effect.annotateLogs`) any active `LogContext` correlation IDs, so
 * every line is self-describing structured JSON, not pretty-printed text.
 * `Logger.batched` owns the flush-on-scope-close behavior, so this sink is
 * flushed automatically whenever the server shuts down.
 *
 * Best-effort: if the log directory can't be created, this returns
 * `undefined` and callers fall back to console-only logging, matching the
 * behavior of the trace and provider event sinks.
 */
export const makeServerLogFileLogger = Effect.fn("makeServerLogFileLogger")(function* (options: {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
}) {
  const sinkResult = yield* Effect.sync(() => {
    try {
      return {
        ok: true as const,
        sink: new RotatingFileSink({
          filePath: options.filePath,
          maxBytes: options.maxBytes,
          maxFiles: options.maxFiles,
          throwOnError: true,
        }),
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  });

  if (!sinkResult.ok) {
    yield* Effect.logWarning("failed to initialize server log file sink", {
      filePath: options.filePath,
      error: sinkResult.error,
    });
    return undefined;
  }

  const sink = sinkResult.sink;

  return yield* Logger.batched(Logger.formatJson, {
    window: `${options.batchWindowMs} millis`,
    flush: Effect.fn("makeServerLogFileLogger.flush")(function* (messages) {
      const flushResult = yield* Effect.sync(() => {
        try {
          for (const message of messages) {
            sink.write(`${message}\n`);
          }
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error };
        }
      });

      if (!flushResult.ok) {
        yield* Effect.logWarning("server log file batch flush failed", {
          filePath: options.filePath,
          error: flushResult.error,
        });
      }
    }),
  });
});

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);

  const fileLogger = yield* makeServerLogFileLogger({
    filePath: config.serverLogPath,
    maxBytes: SERVER_LOG_MAX_BYTES,
    maxFiles: SERVER_LOG_MAX_FILES,
    batchWindowMs: SERVER_LOG_BATCH_WINDOW_MS,
  });

  const loggerLayer = Logger.layer(
    [Logger.consolePretty(), Logger.tracerLogger, ...(fileLogger ? [fileLogger] : [])],
    { mergeWithExisting: false },
  );

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
