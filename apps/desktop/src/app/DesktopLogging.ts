import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const DESKTOP_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const DESKTOP_LOG_FILE_MAX_FILES = 10;
const DESKTOP_LOG_BATCH_WINDOW = Duration.millis(250);

export interface RotatingLogFileWriter {
  readonly writeBytes: (chunk: Uint8Array) => Effect.Effect<void>;
  readonly writeText: (chunk: string) => Effect.Effect<void>;
}

export interface DesktopBackendOutputLogShape {
  readonly writeSessionBoundary: (input: {
    readonly phase: "START" | "END";
    readonly details: string;
  }) => Effect.Effect<void>;
  readonly writeOutputChunk: (
    streamName: "stdout" | "stderr",
    chunk: Uint8Array,
  ) => Effect.Effect<void>;
}

export class DesktopBackendOutputLog extends Context.Service<
  DesktopBackendOutputLog,
  DesktopBackendOutputLogShape
>()("t3/desktop/BackendOutputLog") {}

const textEncoder = new TextEncoder();

class DesktopLogFileWriterConfigurationError extends Data.TaggedError(
  "DesktopLogFileWriterConfigurationError",
)<{
  readonly option: "maxBytes" | "maxFiles";
  readonly value: number;
}> {
  override get message() {
    return `${this.option} must be >= 1 (received ${this.value})`;
  }
}

type DesktopLogFileWriterError =
  | DesktopLogFileWriterConfigurationError
  | PlatformError.PlatformError;

const sanitizeLogValue = (value: string): string => value.replace(/\s+/g, " ").trim();

const DesktopBackendOutputLogNoop: DesktopBackendOutputLogShape = {
  writeSessionBoundary: () => Effect.void,
  writeOutputChunk: () => Effect.void,
};

const currentDesktopRunId = Effect.gen(function* () {
  const annotations = yield* References.CurrentLogAnnotations;
  const runId = annotations.runId;
  return typeof runId === "string" && runId.length > 0 ? runId : "unknown";
});

const refreshFileSize = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<number, never> =>
  fileSystem.stat(filePath).pipe(
    Effect.map((stat) => Number(stat.size)),
    Effect.orElseSucceed(() => 0),
  );

const makeRotatingLogFileWriter = Effect.fn("makeRotatingLogFileWriter")(function* (input: {
  readonly filePath: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}): Effect.fn.Return<
  RotatingLogFileWriter,
  DesktopLogFileWriterError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maxBytes = input.maxBytes ?? DESKTOP_LOG_FILE_MAX_BYTES;
  const maxFiles = input.maxFiles ?? DESKTOP_LOG_FILE_MAX_FILES;
  const directory = path.dirname(input.filePath);
  const baseName = path.basename(input.filePath);

  if (maxBytes < 1) {
    return yield* new DesktopLogFileWriterConfigurationError({
      option: "maxBytes",
      value: maxBytes,
    });
  }
  if (maxFiles < 1) {
    return yield* new DesktopLogFileWriterConfigurationError({
      option: "maxFiles",
      value: maxFiles,
    });
  }

  yield* fileSystem.makeDirectory(directory, { recursive: true });

  const withSuffix = (index: number) => `${input.filePath}.${index}`;
  const currentSize = yield* Ref.make(yield* refreshFileSize(fileSystem, input.filePath));
  const mutex = yield* Semaphore.make(1);

  const pruneOverflowBackups = Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      if (!entry.startsWith(`${baseName}.`)) continue;
      const suffix = Number(entry.slice(baseName.length + 1));
      if (!Number.isInteger(suffix) || suffix <= maxFiles) continue;
      yield* fileSystem.remove(path.join(directory, entry), { force: true }).pipe(Effect.ignore);
    }
  });

  const rotate = Effect.gen(function* () {
    yield* fileSystem.remove(withSuffix(maxFiles), { force: true }).pipe(Effect.ignore);
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = withSuffix(index);
      const sourceExists = yield* fileSystem.exists(source).pipe(Effect.orElseSucceed(() => false));
      if (sourceExists) {
        yield* fileSystem.rename(source, withSuffix(index + 1));
      }
    }
    const currentExists = yield* fileSystem
      .exists(input.filePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (currentExists) {
      yield* fileSystem.rename(input.filePath, withSuffix(1));
    }
    yield* Ref.set(currentSize, 0);
  }).pipe(
    Effect.catch(() =>
      refreshFileSize(fileSystem, input.filePath).pipe(
        Effect.flatMap((size) => Ref.set(currentSize, size)),
      ),
    ),
  );

  const writeBytes = (chunk: Uint8Array): Effect.Effect<void> => {
    if (chunk.byteLength === 0) return Effect.void;

    return mutex.withPermits(1)(
      Effect.gen(function* () {
        const beforeSize = yield* Ref.get(currentSize);
        if (beforeSize > 0 && beforeSize + chunk.byteLength > maxBytes) {
          yield* rotate;
        }

        yield* fileSystem.writeFile(input.filePath, chunk, { flag: "a" });
        const afterSize = (yield* Ref.get(currentSize)) + chunk.byteLength;
        yield* Ref.set(currentSize, afterSize);

        if (afterSize > maxBytes) {
          yield* rotate;
        }
      }).pipe(
        Effect.catch(() =>
          refreshFileSize(fileSystem, input.filePath).pipe(
            Effect.flatMap((size) => Ref.set(currentSize, size)),
          ),
        ),
      ),
    );
  };

  yield* pruneOverflowBackups;

  return {
    writeBytes,
    writeText: (chunk) => writeBytes(textEncoder.encode(chunk)),
  } satisfies RotatingLogFileWriter;
});

const makeDesktopFileLogger = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const writer = yield* makeRotatingLogFileWriter({
    filePath: environment.path.join(environment.logDir, "desktop-main.log"),
  });

  return yield* Logger.batched(Logger.formatJson, {
    window: DESKTOP_LOG_BATCH_WINDOW,
    flush: (messages) =>
      messages.length === 0 ? Effect.void : writer.writeText(`${messages.join("\n")}\n`),
  });
});

const writeDevelopmentConsoleOutput = (
  streamName: "stdout" | "stderr",
  chunk: Uint8Array,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const output = streamName === "stderr" ? process.stderr : process.stdout;
    output.write(chunk);
  }).pipe(Effect.ignore);

export const DesktopLoggerLive = Layer.unwrap(
  Effect.gen(function* () {
    const fileLogger = yield* makeDesktopFileLogger.pipe(Effect.option);
    const loggers: Array<Logger.Logger<unknown, unknown>> = [
      Logger.consolePretty(),
      Logger.tracerLogger,
    ];

    if (Option.isSome(fileLogger)) {
      loggers.push(fileLogger.value);
    }

    return Layer.mergeAll(
      Logger.layer(loggers, { mergeWithExisting: false }),
      Layer.succeed(References.MinimumLogLevel, "Info"),
    );
  }),
);

export const DesktopBackendOutputLogLive = Layer.effect(
  DesktopBackendOutputLog,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;

    const writer = yield* makeRotatingLogFileWriter({
      filePath: environment.path.join(environment.logDir, "server-child.log"),
    }).pipe(Effect.option);

    return Option.match(writer, {
      onNone: () => DesktopBackendOutputLogNoop,
      onSome: (logFile) =>
        ({
          writeSessionBoundary: ({ phase, details }) =>
            Effect.gen(function* () {
              const runId = yield* currentDesktopRunId;
              const timestamp = DateTime.formatIso(yield* DateTime.now);
              yield* logFile.writeText(
                `[${timestamp}] ---- APP SESSION ${phase} run=${runId} ${sanitizeLogValue(details)} ----\n`,
              );
            }),
          writeOutputChunk: (streamName, chunk) =>
            environment.isDevelopment
              ? writeDevelopmentConsoleOutput(streamName, chunk).pipe(
                  Effect.andThen(logFile.writeBytes(chunk)),
                )
              : logFile.writeBytes(chunk),
        }) satisfies DesktopBackendOutputLogShape,
    });
  }),
);
