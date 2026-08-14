import type {
  ServerTraceDiagnosticsErrorKind,
  ServerTraceDiagnosticsFailureSummary,
  ServerTraceDiagnosticsLogEvent,
  ServerTraceDiagnosticsRecentFailure,
  ServerTraceDiagnosticsResult,
  ServerTraceDiagnosticsSpanOccurrence,
  ServerTraceDiagnosticsSpanSummary,
} from "@t3tools/contracts";
import * as NodeZlib from "node:zlib";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

interface TraceRecordLike {
  readonly name?: unknown;
  readonly traceId?: unknown;
  readonly spanId?: unknown;
  readonly startTimeUnixNano?: unknown;
  readonly endTimeUnixNano?: unknown;
  readonly durationMs?: unknown;
  readonly exit?: unknown;
  readonly events?: unknown;
}

interface TraceEventLike {
  readonly name?: unknown;
  readonly timeUnixNano?: unknown;
  readonly attributes?: unknown;
}

export interface TraceDiagnosticsOptions {
  readonly traceFilePath: string;
  readonly maxFiles: number;
  readonly slowSpanThresholdMs?: number;
  readonly readAt?: DateTime.Utc;
}

export class TraceFileReadError extends Schema.TaggedErrorClass<TraceFileReadError>()(
  "TraceFileReadError",
  {
    traceFilePath: Schema.String,
    causeTag: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read local trace file '${this.traceFilePath}'.`;
  }
}

export class TraceDiagnostics extends Context.Service<
  TraceDiagnostics,
  {
    readonly read: (
      options: TraceDiagnosticsOptions,
    ) => Effect.Effect<ServerTraceDiagnosticsResult>;
  }
>()("t3/diagnostics/TraceDiagnostics") {}

interface TraceDiagnosticsInput {
  readonly traceFilePath: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  readonly scannedFilePaths?: ReadonlyArray<string>;
  readonly slowSpanThresholdMs?: number;
  readonly readAt: DateTime.Utc;
  readonly error?: TraceDiagnosticsErrorSummary;
  readonly partialFailure?: boolean;
}

interface TraceDiagnosticsErrorSummary {
  readonly kind: ServerTraceDiagnosticsErrorKind;
  readonly message: string;
}

const DEFAULT_SLOW_SPAN_THRESHOLD_MS = 1_000;
const TOP_LIMIT = 10;
const RECENT_LIMIT = 20;
// Backups rotate as `.N.gz` since compressBackups, but plain `.N` files from
// before the change age along the chain untouched, so both are candidates.
function toRotatedTracePaths(traceFilePath: string, maxFiles: number): ReadonlyArray<string> {
  const backupCount = Math.max(0, Math.floor(maxFiles));
  const backups = Array.from({ length: backupCount }, (_, index) => backupCount - index).flatMap(
    (suffix) => [`${traceFilePath}.${suffix}.gz`, `${traceFilePath}.${suffix}`],
  );
  return [...backups, traceFilePath];
}

function isRecordObject(value: unknown): value is TraceRecordLike {
  return typeof value === "object" && value !== null;
}

function toStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unixNanoToDateTime(value: unknown): DateTime.Utc | null {
  const text = toStringValue(value);
  if (!text) return null;
  try {
    const millis = Number(BigInt(text) / 1_000_000n);
    return Option.getOrNull(DateTime.make(millis));
  } catch {
    return null;
  }
}

function readExitTag(exit: unknown): string | null {
  if (!isRecordObject(exit) || !("_tag" in exit)) return null;
  return toStringValue(exit._tag);
}

function readExitCause(exit: unknown): string {
  if (!isRecordObject(exit) || !("cause" in exit)) return "Failure";
  return toStringValue(exit.cause)?.trim() ?? "Failure";
}

function isTraceEvent(value: unknown): value is TraceEventLike {
  return typeof value === "object" && value !== null;
}

function readEventAttributes(event: TraceEventLike): Readonly<Record<string, unknown>> {
  return typeof event.attributes === "object" && event.attributes !== null
    ? (event.attributes as Readonly<Record<string, unknown>>)
    : {};
}

function makeEmptyDiagnostics(input: {
  readonly traceFilePath: string;
  readonly scannedFilePaths: ReadonlyArray<string>;
  readonly readAt: DateTime.Utc;
  readonly slowSpanThresholdMs: number;
  readonly error?: TraceDiagnosticsErrorSummary;
  readonly partialFailure?: boolean;
}): ServerTraceDiagnosticsResult {
  return {
    traceFilePath: input.traceFilePath,
    scannedFilePaths: [...input.scannedFilePaths],
    readAt: input.readAt,
    recordCount: 0,
    parseErrorCount: 0,
    firstSpanAt: Option.none(),
    lastSpanAt: Option.none(),
    failureCount: 0,
    interruptionCount: 0,
    slowSpanThresholdMs: input.slowSpanThresholdMs,
    slowSpanCount: 0,
    logLevelCounts: {},
    topSpansByCount: [],
    slowestSpans: [],
    commonFailures: [],
    latestFailures: [],
    latestWarningAndErrorLogs: [],
    partialFailure: input.partialFailure ? Option.some(true) : Option.none(),
    error: Option.fromNullishOr(input.error),
  };
}

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

function insertBoundedSlowestSpan(
  slowestSpans: ServerTraceDiagnosticsSpanOccurrence[],
  span: ServerTraceDiagnosticsSpanOccurrence,
): void {
  if (
    slowestSpans.length >= TOP_LIMIT &&
    span.durationMs <= slowestSpans[slowestSpans.length - 1]!.durationMs
  ) {
    return;
  }

  slowestSpans.push(span);
  slowestSpans.sort((left, right) => right.durationMs - left.durationMs);
  if (slowestSpans.length > TOP_LIMIT) {
    slowestSpans.length = TOP_LIMIT;
  }
}

// Incremental aggregation lets the reader feed one decoded file at a time and
// drop its text before touching the next, so peak memory stays one file wide
// no matter how many rotated backups exist.
export function createTraceDiagnosticsAggregator(slowSpanThresholdMs: number) {
  let parseErrorCount = 0;
  let recordCount = 0;
  let failureCount = 0;
  let interruptionCount = 0;
  let slowSpanCount = 0;
  let firstSpanAt: DateTime.Utc | null = null;
  let lastSpanAt: DateTime.Utc | null = null;

  const spansByName = new Map<
    string,
    { count: number; failureCount: number; totalDurationMs: number; maxDurationMs: number }
  >();
  const failuresByKey = new Map<string, ServerTraceDiagnosticsFailureSummary>();
  const latestFailures: ServerTraceDiagnosticsRecentFailure[] = [];
  const slowestSpans: ServerTraceDiagnosticsSpanOccurrence[] = [];
  const latestWarningAndErrorLogs: ServerTraceDiagnosticsLogEvent[] = [];
  const logLevelCounts: Record<string, number> = {};

  const addFileText = (text: string) => {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parseErrorCount += 1;
        continue;
      }

      if (!isRecordObject(parsed)) {
        parseErrorCount += 1;
        continue;
      }

      const name = toStringValue(parsed.name);
      const traceId = toStringValue(parsed.traceId);
      const spanId = toStringValue(parsed.spanId);
      const durationMs = toNumberValue(parsed.durationMs);
      const endedAt = unixNanoToDateTime(parsed.endTimeUnixNano);
      const startedAt = unixNanoToDateTime(parsed.startTimeUnixNano);

      if (!name || !traceId || !spanId || durationMs === null || !endedAt) {
        parseErrorCount += 1;
        continue;
      }

      recordCount += 1;
      firstSpanAt =
        startedAt && (firstSpanAt === null || DateTime.isLessThan(startedAt, firstSpanAt))
          ? startedAt
          : firstSpanAt;
      lastSpanAt =
        lastSpanAt === null || DateTime.isGreaterThan(endedAt, lastSpanAt) ? endedAt : lastSpanAt;

      const exitTag = readExitTag(parsed.exit);
      const isFailure = exitTag === "Failure";
      const isInterrupted = exitTag === "Interrupted";
      if (isFailure) failureCount += 1;
      if (isInterrupted) interruptionCount += 1;

      const spanSummary = spansByName.get(name) ?? {
        count: 0,
        failureCount: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
      };
      spanSummary.count += 1;
      spanSummary.totalDurationMs += durationMs;
      spanSummary.maxDurationMs = Math.max(spanSummary.maxDurationMs, durationMs);
      if (isFailure) spanSummary.failureCount += 1;
      spansByName.set(name, spanSummary);

      const spanItem = { name, durationMs, endedAt, traceId, spanId };
      if (durationMs >= slowSpanThresholdMs) {
        slowSpanCount += 1;
      }
      insertBoundedSlowestSpan(slowestSpans, spanItem);

      if (isFailure) {
        const cause = readExitCause(parsed.exit);
        latestFailures.push({ ...spanItem, cause });

        const failureKey = `${name}\0${cause}`;
        const existing = failuresByKey.get(failureKey);
        const isLatestFailure = !existing || DateTime.isGreaterThan(endedAt, existing.lastSeenAt);
        failuresByKey.set(failureKey, {
          name,
          cause,
          count: (existing?.count ?? 0) + 1,
          lastSeenAt: isLatestFailure ? endedAt : existing!.lastSeenAt,
          traceId: isLatestFailure ? traceId : existing!.traceId,
          spanId: isLatestFailure ? spanId : existing!.spanId,
        });
      }

      if (Array.isArray(parsed.events)) {
        for (const rawEvent of parsed.events) {
          if (!isTraceEvent(rawEvent)) continue;
          const attributes = readEventAttributes(rawEvent);
          const level = toStringValue(attributes["effect.logLevel"]);
          if (!level) continue;

          logLevelCounts[level] = (logLevelCounts[level] ?? 0) + 1;
          const normalizedLevel = level.toLowerCase();
          if (
            normalizedLevel !== "warning" &&
            normalizedLevel !== "warn" &&
            normalizedLevel !== "error" &&
            normalizedLevel !== "fatal"
          ) {
            continue;
          }

          const seenAt = unixNanoToDateTime(rawEvent.timeUnixNano) ?? endedAt;
          const message = toStringValue(rawEvent.name)?.trim() ?? "Log event";
          latestWarningAndErrorLogs.push({
            spanName: name,
            level,
            message,
            seenAt,
            traceId,
            spanId,
          });
        }
      }
    }
  };

  const finish = (input: {
    readonly traceFilePath: string;
    readonly scannedFilePaths: ReadonlyArray<string>;
    readonly readAt: DateTime.Utc;
    readonly error?: TraceDiagnosticsErrorSummary;
    readonly partialFailure?: boolean;
  }): ServerTraceDiagnosticsResult => {
    const topSpansByCount: ServerTraceDiagnosticsSpanSummary[] = [...spansByName.entries()]
      .map(([name, span]) => ({
        name,
        count: span.count,
        failureCount: span.failureCount,
        totalDurationMs: span.totalDurationMs,
        averageDurationMs: span.count > 0 ? span.totalDurationMs / span.count : 0,
        maxDurationMs: span.maxDurationMs,
      }))
      .toSorted(
        (left, right) => right.count - left.count || right.maxDurationMs - left.maxDurationMs,
      )
      .slice(0, TOP_LIMIT);

    return {
      traceFilePath: input.traceFilePath,
      scannedFilePaths: [...input.scannedFilePaths],
      readAt: input.readAt,
      recordCount,
      parseErrorCount,
      firstSpanAt: Option.fromNullishOr(firstSpanAt),
      lastSpanAt: Option.fromNullishOr(lastSpanAt),
      failureCount,
      interruptionCount,
      slowSpanThresholdMs,
      slowSpanCount,
      logLevelCounts,
      topSpansByCount,
      slowestSpans,
      commonFailures: [...failuresByKey.values()]
        .toSorted(
          (left, right) =>
            right.count - left.count ||
            DateTime.toEpochMillis(right.lastSeenAt) - DateTime.toEpochMillis(left.lastSeenAt),
        )
        .slice(0, TOP_LIMIT),
      latestFailures: latestFailures
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.endedAt) - DateTime.toEpochMillis(left.endedAt),
        )
        .slice(0, RECENT_LIMIT),
      latestWarningAndErrorLogs: latestWarningAndErrorLogs
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.seenAt) - DateTime.toEpochMillis(left.seenAt),
        )
        .slice(0, RECENT_LIMIT),
      partialFailure: input.partialFailure ? Option.some(true) : Option.none(),
      error: Option.fromNullishOr(input.error),
    };
  };

  return { addFileText, finish };
}

export function aggregateTraceDiagnostics(
  input: TraceDiagnosticsInput,
): ServerTraceDiagnosticsResult {
  const readAt = input.readAt;
  const slowSpanThresholdMs = input.slowSpanThresholdMs ?? DEFAULT_SLOW_SPAN_THRESHOLD_MS;
  const scannedFilePaths = input.scannedFilePaths ?? input.files.map((file) => file.path);
  if (input.files.length === 0) {
    return makeEmptyDiagnostics({
      traceFilePath: input.traceFilePath,
      scannedFilePaths,
      readAt,
      slowSpanThresholdMs,
      error: input.error ?? {
        kind: "trace-file-not-found",
        message: "No local trace files were found.",
      },
      ...(input.partialFailure ? { partialFailure: true } : {}),
    });
  }

  const aggregator = createTraceDiagnosticsAggregator(slowSpanThresholdMs);
  for (const file of input.files) {
    aggregator.addFileText(file.text);
  }
  return aggregator.finish({
    traceFilePath: input.traceFilePath,
    scannedFilePaths,
    readAt,
    ...(input.error ? { error: input.error } : {}),
    ...(input.partialFailure ? { partialFailure: true } : {}),
  });
}

type TraceFileReadResult =
  | { readonly _tag: "Loaded"; readonly path: string; readonly text: string }
  | { readonly _tag: "Missing"; readonly path: string };

function readTraceFile(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<TraceFileReadResult, TraceFileReadError> {
  const decoded = path.endsWith(".gz")
    ? fileSystem.readFile(path).pipe(
        Effect.flatMap((bytes) =>
          Effect.try({
            try: () => NodeZlib.gunzipSync(bytes).toString("utf8"),
            catch: (cause) =>
              new TraceFileReadError({
                traceFilePath: path,
                causeTag: "GzipDecode",
                cause,
              }),
          }),
        ),
      )
    : fileSystem.readFileString(path);
  return decoded.pipe(
    Effect.map((text): TraceFileReadResult => ({ _tag: "Loaded", path, text })),
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFoundError(cause)
          ? Effect.succeed<TraceFileReadResult>({ _tag: "Missing", path })
          : Effect.fail(
              new TraceFileReadError({
                traceFilePath: path,
                causeTag: cause.reason._tag,
                cause,
              }),
            ),
    }),
  );
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  const read: TraceDiagnostics["Service"]["read"] = Effect.fn("TraceDiagnostics.read")(
    function* (options) {
      const readAt = options.readAt ?? (yield* DateTime.now);
      const slowSpanThresholdMs = options.slowSpanThresholdMs ?? DEFAULT_SLOW_SPAN_THRESHOLD_MS;
      const paths = toRotatedTracePaths(options.traceFilePath, options.maxFiles);
      // One file at a time: each decoded text is aggregated and released
      // before the next read, so a large maxFiles never loads the whole
      // rotation window into memory at once.
      const aggregator = createTraceDiagnosticsAggregator(slowSpanThresholdMs);
      let loadedFileCount = 0;
      let readFailureError: TraceDiagnosticsErrorSummary | undefined;
      const loadedPaths = new Set<string>();
      for (const path of paths) {
        // A plain backup next to its own .gz copy is a crash leftover with
        // identical content — counting both would double every span in it.
        if (!path.endsWith(".gz") && loadedPaths.has(`${path}.gz`)) {
          continue;
        }
        const result = yield* readTraceFile(fileSystem, path).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to read local trace file.").pipe(
              Effect.annotateLogs({
                traceFilePath: cause.traceFilePath,
                errorTag: cause._tag,
                causeTag: cause.causeTag,
              }),
            ),
          ),
          Effect.result,
        );
        if (Result.isFailure(result)) {
          readFailureError ??= {
            kind: "trace-file-read-failed",
            message: result.failure.message,
          } satisfies TraceDiagnosticsErrorSummary;
          continue;
        }
        if (result.success._tag === "Loaded") {
          loadedFileCount += 1;
          loadedPaths.add(path);
          aggregator.addFileText(result.success.text);
        }
      }

      if (loadedFileCount === 0) {
        return makeEmptyDiagnostics({
          traceFilePath: options.traceFilePath,
          scannedFilePaths: paths,
          readAt,
          slowSpanThresholdMs,
          error:
            readFailureError ??
            ({
              kind: "trace-file-not-found",
              message: "No local trace files were found.",
            } satisfies TraceDiagnosticsErrorSummary),
        });
      }

      return aggregator.finish({
        traceFilePath: options.traceFilePath,
        scannedFilePaths: paths,
        readAt,
        ...(readFailureError ? { partialFailure: true, error: readFailureError } : {}),
      });
    },
  );

  return TraceDiagnostics.of({ read });
});

export const layer = Layer.effect(TraceDiagnostics, make);

export function readTraceDiagnostics(
  options: TraceDiagnosticsOptions,
): Effect.Effect<ServerTraceDiagnosticsResult, never, TraceDiagnostics> {
  return Effect.gen(function* () {
    const diagnostics = yield* TraceDiagnostics;
    return yield* diagnostics.read(options);
  });
}
