import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export const DESKTOP_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const DESKTOP_LOG_FILE_MAX_FILES = 10;

const DESKTOP_BACKEND_CHILD_LOG_FIBER_ID = "#backend-child";

interface RotatingLogFileWriter {
  readonly filePath: string;
  readonly writeBytes: (
    chunk: Uint8Array,
  ) => Effect.Effect<void, PlatformError.PlatformError | DesktopLogFileWriterRecoveryError>;
  readonly writeText: (
    chunk: string,
  ) => Effect.Effect<void, PlatformError.PlatformError | DesktopLogFileWriterRecoveryError>;
}

class DesktopLogFileWriterConfigurationError extends Schema.TaggedErrorClass<DesktopLogFileWriterConfigurationError>()(
  "DesktopLogFileWriterConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles"]),
    value: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.option} must be >= 1 (received ${this.value})`;
  }
}

class DesktopLogFileWriterRecoveryError extends Schema.TaggedErrorClass<DesktopLogFileWriterRecoveryError>()(
  "DesktopLogFileWriterRecoveryError",
  {
    logFilePath: Schema.String,
    cause: Schema.Defect(),
    recoveryCause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to refresh desktop backend output log size after a write failure at ${this.logFilePath}.`;
  }
}

export class DesktopBackendOutputLogSetupError extends Schema.TaggedErrorClass<DesktopBackendOutputLogSetupError>()(
  "DesktopBackendOutputLogSetupError",
  {
    logFilePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the desktop backend output log at ${this.logFilePath}.`;
  }
}

export class DesktopBackendOutputLogWriteError extends Schema.TaggedErrorClass<DesktopBackendOutputLogWriteError>()(
  "DesktopBackendOutputLogWriteError",
  {
    operation: Schema.Literals(["encode-record", "write-record"]),
    logFilePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop backend output log operation "${this.operation}" failed at ${this.logFilePath}.`;
  }
}

export class DesktopBackendConsoleWriteError extends Schema.TaggedErrorClass<DesktopBackendConsoleWriteError>()(
  "DesktopBackendConsoleWriteError",
  {
    streamName: Schema.Literals(["stdout", "stderr"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to mirror desktop backend output to ${this.streamName}.`;
  }
}

export class DesktopBackendOutputLog extends Context.Service<
  DesktopBackendOutputLog,
  {
    readonly writeSessionBoundary: (input: {
      readonly phase: "START" | "END";
      readonly details: string;
    }) => Effect.Effect<void>;
    readonly writeOutputChunk: (
      streamName: "stdout" | "stderr",
      chunk: Uint8Array,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopBackendOutputLog") {}

type DesktopLogFileWriterError =
  | DesktopLogFileWriterConfigurationError
  | PlatformError.PlatformError;

const DesktopBackendChildLogRecord = Schema.Struct({
  message: Schema.String,
  level: Schema.Literals(["INFO", "ERROR"]),
  timestamp: Schema.String,
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  spans: Schema.Record(Schema.String, Schema.Unknown),
  fiberId: Schema.String,
});

const encodeDesktopBackendChildLogRecord = Schema.encodeEffect(
  Schema.fromJsonString(DesktopBackendChildLogRecord),
);

const DesktopBackendOutputLogNoop: DesktopBackendOutputLog["Service"] = {
  writeSessionBoundary: () => Effect.void,
  writeOutputChunk: () => Effect.void,
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const currentDesktopRunId = Effect.gen(function* () {
  const annotations = yield* References.CurrentLogAnnotations;
  const runId = annotations.runId;
  return typeof runId === "string" && runId.length > 0 ? runId : "unknown";
});

const sanitizeLogValue = (value: string): string => value.replace(/\s+/g, " ").trim();

const refreshFileSize = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<number, PlatformError.PlatformError> =>
  fileSystem.stat(filePath).pipe(
    Effect.map((stat) => Number(stat.size)),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(0) : Effect.fail(error),
    }),
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

  const recoverCurrentSize = (
    cause: PlatformError.PlatformError,
  ): Effect.Effect<never, PlatformError.PlatformError | DesktopLogFileWriterRecoveryError> =>
    refreshFileSize(fileSystem, input.filePath).pipe(
      Effect.matchEffect({
        onFailure: (recoveryCause) =>
          Effect.fail(
            new DesktopLogFileWriterRecoveryError({
              logFilePath: input.filePath,
              cause,
              recoveryCause,
            }),
          ),
        onSuccess: (size) => Ref.set(currentSize, size).pipe(Effect.andThen(Effect.fail(cause))),
      }),
    );

  const pruneOverflowBackups = Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(directory);
    for (const entry of entries) {
      if (!entry.startsWith(`${baseName}.`)) continue;
      const suffix = Number(entry.slice(baseName.length + 1));
      if (!Number.isInteger(suffix) || suffix <= maxFiles) continue;
      yield* fileSystem.remove(path.join(directory, entry), { force: true });
    }
  });

  const rotate = Effect.gen(function* () {
    yield* fileSystem.remove(withSuffix(maxFiles), { force: true });
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = withSuffix(index);
      const sourceExists = yield* fileSystem.exists(source);
      if (sourceExists) {
        yield* fileSystem.rename(source, withSuffix(index + 1));
      }
    }
    const currentExists = yield* fileSystem.exists(input.filePath);
    if (currentExists) {
      yield* fileSystem.rename(input.filePath, withSuffix(1));
    }
    yield* Ref.set(currentSize, 0);
  });

  const writeBytes = (
    chunk: Uint8Array,
  ): Effect.Effect<void, PlatformError.PlatformError | DesktopLogFileWriterRecoveryError> => {
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
        Effect.catchTags({
          PlatformError: recoverCurrentSize,
        }),
      ),
    );
  };

  yield* pruneOverflowBackups;

  return {
    filePath: input.filePath,
    writeBytes,
    writeText: (chunk) => writeBytes(textEncoder.encode(chunk)),
  } satisfies RotatingLogFileWriter;
});

const writeDevelopmentConsoleOutput = (
  streamName: "stdout" | "stderr",
  chunk: Uint8Array,
): Effect.Effect<void> =>
  Effect.try({
    try: () => {
      const output = streamName === "stderr" ? process.stderr : process.stdout;
      output.write(chunk);
    },
    catch: (cause) => new DesktopBackendConsoleWriteError({ streamName, cause }),
  }).pipe(
    Effect.catchTags({
      DesktopBackendConsoleWriteError: (error) => Effect.logError(error.message, { error }),
    }),
  );

const writeBackendChildLogRecord = Effect.fn("desktop.observability.writeBackendChildLogRecord")(
  function* (
    logFile: RotatingLogFileWriter,
    input: {
      readonly message: string;
      readonly level: "INFO" | "ERROR";
      readonly annotations: Record<string, unknown>;
    },
  ): Effect.fn.Return<void> {
    return yield* Effect.gen(function* () {
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const encoded = yield* encodeDesktopBackendChildLogRecord({
        message: input.message,
        level: input.level,
        timestamp,
        annotations: input.annotations,
        spans: {},
        fiberId: DESKTOP_BACKEND_CHILD_LOG_FIBER_ID,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopBackendOutputLogWriteError({
              operation: "encode-record",
              logFilePath: logFile.filePath,
              cause,
            }),
        ),
      );
      yield* logFile.writeText(`${encoded}\n`).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopBackendOutputLogWriteError({
              operation: "write-record",
              logFilePath: logFile.filePath,
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.catchTags({
        DesktopBackendOutputLogWriteError: (error) => Effect.logError(error.message, { error }),
      }),
    );
  },
);

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const logFilePath = environment.path.join(environment.logDir, "server-child.log");
  const writer = yield* makeRotatingLogFileWriter({
    filePath: logFilePath,
  }).pipe(
    Effect.mapError((cause) => new DesktopBackendOutputLogSetupError({ logFilePath, cause })),
    Effect.map(Option.some),
    Effect.catchTags({
      DesktopBackendOutputLogSetupError: (error) =>
        Effect.logError(error.message, { error }).pipe(Effect.as(Option.none())),
    }),
  );

  const service = Option.match(writer, {
    onNone: () => DesktopBackendOutputLogNoop,
    onSome: (logFile) =>
      ({
        writeSessionBoundary: Effect.fn("desktop.observability.backendOutput.writeSessionBoundary")(
          function* ({ phase, details }) {
            const runId = yield* currentDesktopRunId;
            yield* writeBackendChildLogRecord(logFile, {
              message: `backend child process session ${phase.toLowerCase()}`,
              level: "INFO",
              annotations: {
                component: "desktop-backend-child",
                runId,
                phase,
                details: sanitizeLogValue(details),
              },
            });
          },
        ),
        writeOutputChunk: Effect.fn("desktop.observability.backendOutput.writeOutputChunk")(
          function* (streamName, chunk) {
            if (environment.isDevelopment) {
              yield* writeDevelopmentConsoleOutput(streamName, chunk);
            }
            const runId = yield* currentDesktopRunId;
            yield* writeBackendChildLogRecord(logFile, {
              message: "backend child process output",
              level: streamName === "stderr" ? "ERROR" : "INFO",
              annotations: {
                component: "desktop-backend-child",
                runId,
                stream: streamName,
                text: textDecoder.decode(chunk),
              },
            });
          },
        ),
      }) satisfies DesktopBackendOutputLog["Service"],
  });

  return DesktopBackendOutputLog.of(service);
});

export const layer = Layer.effect(DesktopBackendOutputLog, make);
