import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { makeLocalFileTracer, makeTraceSink } from "@t3tools/shared/observability";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Tracer from "effect/Tracer";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const DESKTOP_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const DESKTOP_LOG_FILE_MAX_FILES = 10;
const DESKTOP_BACKEND_CHILD_LOG_FIBER_ID = "#backend-child";
const DESKTOP_TRACE_BATCH_WINDOW_MS = 200;

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

// Factory for per-instance backend output logs. `forInstance(id)` returns
// a writer that targets a distinct rotating log file — the primary
// instance keeps `server-child.log` so the historical path stays stable
// for ops; other instances get `server-child-<sanitized-id>.log`.
//
// Writers are cached per id within a single factory instance so repeated
// `forInstance` calls (e.g. during a backend restart that re-resolves
// services) reuse the same rotating writer rather than racing each other
// on the same file.
export class DesktopBackendOutputLogFactory extends Context.Service<
  DesktopBackendOutputLogFactory,
  {
    readonly forInstance: (id: string) => Effect.Effect<DesktopBackendOutputLogShape>;
  }
>()("@t3tools/desktop/app/DesktopObservability/DesktopBackendOutputLogFactory") {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type DesktopLogAnnotations = Record<string, unknown>;

export interface DesktopComponentLogger {
  readonly annotate: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    annotations?: DesktopLogAnnotations,
  ) => Effect.Effect<A, E, R>;
  readonly logDebug: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
  readonly logInfo: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
  readonly logWarning: (
    message: string,
    annotations?: DesktopLogAnnotations,
  ) => Effect.Effect<void>;
  readonly logError: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
}

export function makeComponentLogger(component: string): DesktopComponentLogger {
  const annotate: DesktopComponentLogger["annotate"] = (effect, annotations) =>
    effect.pipe(
      Effect.annotateLogs({
        component,
        ...annotations,
      }),
    );

  return {
    annotate,
    logDebug: (message, annotations) => annotate(Effect.logDebug(message), annotations),
    logInfo: (message, annotations) => annotate(Effect.logInfo(message), annotations),
    logWarning: (message, annotations) => annotate(Effect.logWarning(message), annotations),
    logError: (message, annotations) => annotate(Effect.logError(message), annotations),
  };
}

class DesktopLogFileWriterConfigurationError extends Schema.TaggedErrorClass<DesktopLogFileWriterConfigurationError>()(
  "DesktopLogFileWriterConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles"]),
    value: Schema.Number,
  },
) {
  override get message() {
    return `${this.option} must be >= 1 (received ${this.value})`;
  }
}

type DesktopLogFileWriterError =
  | DesktopLogFileWriterConfigurationError
  | PlatformError.PlatformError;

const sanitizeLogValue = (value: string): string => value.replace(/\s+/g, " ").trim();

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

const readPersistedOtlpTracesUrl: Effect.Effect<
  Option.Option<string>,
  never,
  FileSystem.FileSystem | DesktopEnvironment.DesktopEnvironment
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fileSystem.readFileString(environment.serverSettingsPath).pipe(Effect.option);
  if (Option.isNone(raw)) {
    return Option.none();
  }

  const parsed = parsePersistedServerObservabilitySettings(raw.value);
  return Option.fromNullishOr(parsed.otlpTracesUrl);
});

const resolveOtlpTracesUrl = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (Option.isSome(environment.otlpTracesUrl)) {
    return environment.otlpTracesUrl;
  }
  return yield* readPersistedOtlpTracesUrl;
});

const writeDevelopmentConsoleOutput = (
  streamName: "stdout" | "stderr",
  chunk: Uint8Array,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const output = streamName === "stderr" ? process.stderr : process.stdout;
    output.write(chunk);
  }).pipe(Effect.ignore);

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
      });
      yield* logFile.writeText(`${encoded}\n`);
    }).pipe(Effect.ignore({ log: true }));
  },
);

const PRIMARY_BACKEND_LOG_INSTANCE_ID = PRIMARY_LOCAL_ENVIRONMENT_ID;

const sanitizeInstanceIdForFileName = (id: string): string => id.replace(/[^a-zA-Z0-9._-]+/g, "_");

const backendLogFilePathForInstance = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  id: string,
): string => {
  // Primary keeps the historical "server-child.log" path so ops scripts
  // and packaged-build log inspection still find it where it always lived.
  if (id === PRIMARY_BACKEND_LOG_INSTANCE_ID) {
    return environment.path.join(environment.logDir, "server-child.log");
  }
  const sanitized = sanitizeInstanceIdForFileName(id);
  return environment.path.join(environment.logDir, `server-child-${sanitized}.log`);
};

// Just the IO sink. Cacheable by resolved file path so two ids that
// sanitize to the same filename share a single RotatingLogFileWriter
// (no race on currentSize tracking). Splitting the sink off from the
// per-call shape lets the shape annotate writes with the *caller's*
// id rather than whatever id created the cached writer first.
const makeBackendOutputSinkForInstance = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  id: string,
): Effect.Effect<
  Option.Option<RotatingLogFileWriter>,
  never,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  makeRotatingLogFileWriter({
    filePath: backendLogFilePathForInstance(environment, id),
  }).pipe(Effect.option);

const makeBackendOutputLogShape = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  id: string,
  sink: Option.Option<RotatingLogFileWriter>,
): DesktopBackendOutputLogShape =>
  Option.match(sink, {
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
                instanceId: id,
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
                instanceId: id,
                stream: streamName,
                text: textDecoder.decode(chunk),
              },
            });
          },
        ),
      }) satisfies DesktopBackendOutputLogShape,
  });

const backendOutputLogFactoryLayer = Layer.effect(
  DesktopBackendOutputLogFactory,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const factoryScope = yield* Scope.Scope;
    // Per-file-path cache of the IO sink only. The per-call shape
    // wraps the sink with the caller's instance id so a cache hit on
    // a path collision (e.g. "wsl:default" and "wsl_default" both
    // resolve to server-child-wsl_default.log) doesn't attribute the
    // second caller's writes to the first caller's id. Each sink pins
    // itself to the factory's scope so all log resources tear down
    // together at app exit. Mutex serializes concurrent first-time
    // lookups for the same file path.
    const cacheRef = yield* SynchronizedRef.make<
      ReadonlyMap<string, Option.Option<RotatingLogFileWriter>>
    >(new Map());

    const makeForId = (id: string): Effect.Effect<DesktopBackendOutputLogShape> =>
      SynchronizedRef.modifyEffect(cacheRef, (cache) => {
        const cacheKey = backendLogFilePathForInstance(environment, id);
        const cached = cache.get(cacheKey);
        if (cached !== undefined) {
          return Effect.succeed([
            makeBackendOutputLogShape(environment, id, cached),
            cache,
          ] as const);
        }
        return makeBackendOutputSinkForInstance(environment, id).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Scope.provide(factoryScope),
          Effect.map((sink) => {
            const next = new Map(cache);
            next.set(cacheKey, sink);
            return [
              makeBackendOutputLogShape(environment, id, sink),
              next as ReadonlyMap<string, Option.Option<RotatingLogFileWriter>>,
            ] as const;
          }),
        );
      });

    return DesktopBackendOutputLogFactory.of({
      forInstance: (id) => makeForId(id),
    });
  }),
);

const desktopLoggerLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty(), Logger.tracerLogger], { mergeWithExisting: false }),
  Layer.succeed(References.MinimumLogLevel, "Info"),
);

const tracerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const otlpTracesUrl = yield* resolveOtlpTracesUrl;
    const tracePath = environment.path.join(environment.logDir, "desktop.trace.ndjson");
    const sink = yield* makeTraceSink({
      filePath: tracePath,
      maxBytes: DESKTOP_LOG_FILE_MAX_BYTES,
      maxFiles: DESKTOP_LOG_FILE_MAX_FILES,
      batchWindowMs: DESKTOP_TRACE_BATCH_WINDOW_MS,
    });
    const delegate = Option.isNone(otlpTracesUrl)
      ? undefined
      : yield* OtlpTracer.make({
          url: otlpTracesUrl.value,
          exportInterval: `${environment.otlpExportIntervalMs} millis`,
          resource: {
            serviceName: "desktop",
            attributes: {
              "service.runtime": "desktop",
              "service.mode": environment.isDevelopment ? "development" : "packaged",
            },
          },
        });
    const tracer = yield* makeLocalFileTracer({
      filePath: tracePath,
      maxBytes: DESKTOP_LOG_FILE_MAX_BYTES,
      maxFiles: DESKTOP_LOG_FILE_MAX_FILES,
      batchWindowMs: DESKTOP_TRACE_BATCH_WINDOW_MS,
      sink,
      ...(delegate ? { delegate } : {}),
    });

    return Layer.succeed(Tracer.Tracer, tracer);
  }),
).pipe(Layer.provideMerge(OtlpSerialization.layerJson));

export const layer = Layer.mergeAll(
  backendOutputLogFactoryLayer,
  desktopLoggerLayer,
  tracerLayer,
  Layer.succeed(Tracer.MinimumTraceLevel, "Info"),
  Layer.succeed(References.TracerTimingEnabled, true),
);
