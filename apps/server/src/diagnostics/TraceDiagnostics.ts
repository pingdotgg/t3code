import type {
  ServerTraceDiagnosticsErrorKind,
  ServerTraceDiagnosticsFailureSummary,
  ServerTraceDiagnosticsLogEvent,
  ServerTraceDiagnosticsRecentFailure,
  ServerTraceDiagnosticsResult,
  ServerTraceDiagnosticsSpanOccurrence,
  ServerTraceDiagnosticsSpanSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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

export class TraceFileReadError extends Schema.TaggedError<TraceFileReadError>()(
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

interface TraceDiagnosticsErrorSummary {
  readonly kind: ServerTraceDiagnosticsErrorKind;
  readonly message: string;
}

const DEFAULT_SLOW_SPAN_THRESHOLD_MS = 1_000;
const TOP_LIMIT = 10;
const RECENT_LIMIT = 20;

/** The trace file and its rotated backups, oldest first. */
export function toRotatedTracePaths(
  traceFilePath: string,
  maxFiles: number,
): ReadonlyArray<string> {
  const backupCount = Math.max(0, Math.floor(maxFiles));
  const backups = Array.from(
    { length: backupCount },
    (_, index) => `${traceFilePath}.${backupCount - index}`,
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

/**
 * Adds `item` to `items`, which stays sorted by `order` and holds at most
 * `limit` entries. Same result as a stable sort and slice over every item, but
 * memory stays bounded however many items stream in.
 */
function insertBounded<A>(
  items: A[],
  item: A,
  limit: number,
  order: (left: A, right: A) => number,
): void {
  if (items.length >= limit && order(item, items[items.length - 1]!) >= 0) {
    return;
  }

  items.push(item);
  items.sort(order);
  if (items.length > limit) {
    items.length = limit;
  }
}

const slowestFirst = (
  left: ServerTraceDiagnosticsSpanOccurrence,
  right: ServerTraceDiagnosticsSpanOccurrence,
) => right.durationMs - left.durationMs;

const latestEndedFirst = (
  left: ServerTraceDiagnosticsRecentFailure,
  right: ServerTraceDiagnosticsRecentFailure,
) => DateTime.toEpochMillis(right.endedAt) - DateTime.toEpochMillis(left.endedAt);

const latestSeenFirst = (
  left: ServerTraceDiagnosticsLogEvent,
  right: ServerTraceDiagnosticsLogEvent,
) => DateTime.toEpochMillis(right.seenAt) - DateTime.toEpochMillis(left.seenAt);

/**
 * Folds trace NDJSON into diagnostics. Call `addLine` once per line as the
 * rotated files stream in, then `finish` for the result.
 */
export function makeTraceDiagnosticsAggregator(
  slowSpanThresholdMs = DEFAULT_SLOW_SPAN_THRESHOLD_MS,
) {
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

  const addLine = (line: string) => {
    if (line.trim().length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parseErrorCount += 1;
      return;
    }

    if (!isRecordObject(parsed)) {
      parseErrorCount += 1;
      return;
    }

    const name = toStringValue(parsed.name);
    const traceId = toStringValue(parsed.traceId);
    const spanId = toStringValue(parsed.spanId);
    const durationMs = toNumberValue(parsed.durationMs);
    const endedAt = unixNanoToDateTime(parsed.endTimeUnixNano);
    const startedAt = unixNanoToDateTime(parsed.startTimeUnixNano);

    if (!name || !traceId || !spanId || durationMs === null || !endedAt) {
      parseErrorCount += 1;
      return;
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
    insertBounded(slowestSpans, spanItem, TOP_LIMIT, slowestFirst);

    if (isFailure) {
      const cause = readExitCause(parsed.exit);
      insertBounded(latestFailures, { ...spanItem, cause }, RECENT_LIMIT, latestEndedFirst);

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
        insertBounded(
          latestWarningAndErrorLogs,
          { spanName: name, level, message, seenAt, traceId, spanId },
          RECENT_LIMIT,
          latestSeenFirst,
        );
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
      scannedFilePaths: input.scannedFilePaths,
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
      latestFailures,
      latestWarningAndErrorLogs,
      partialFailure: input.partialFailure ? Option.some(true) : Option.none(),
      error: Option.fromNullishOr(input.error),
    };
  };

  return { addLine, finish };
}

/**
 * Feeds each line of one trace file to `onLine`, streaming so only one chunk of
 * text is in memory at a time. Succeeds with false when the file does not exist.
 */
export function streamTraceFileLines(
  fileSystem: FileSystem.FileSystem,
  path: string,
  onLine: (line: string) => void,
): Effect.Effect<boolean, TraceFileReadError> {
  return fileSystem.stream(path).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEachArray((lines) => Effect.sync(() => lines.forEach(onLine))),
    Effect.as(true),
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFoundError(cause)
          ? Effect.succeed(false)
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

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  const read: TraceDiagnostics["Service"]["read"] = Effect.fn("TraceDiagnostics.read")(
    function* (options) {
      const readAt = options.readAt ?? (yield* DateTime.now);
      const slowSpanThresholdMs = options.slowSpanThresholdMs ?? DEFAULT_SLOW_SPAN_THRESHOLD_MS;
      const paths = toRotatedTracePaths(options.traceFilePath, options.maxFiles);
      const aggregator = makeTraceDiagnosticsAggregator(slowSpanThresholdMs);
      const results = yield* Effect.forEach(
        paths,
        (path) =>
          streamTraceFileLines(fileSystem, path, aggregator.addLine).pipe(
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
          ),
        // Every file feeds one aggregator, so read them one at a time, oldest first.
        { concurrency: 1 },
      );
      const foundFile = results.some((result) => Result.isSuccess(result) && result.success);
      const readFailure = results.find(Result.isFailure);
      const readFailureError = readFailure
        ? ({
            kind: "trace-file-read-failed",
            message: readFailure.failure.message,
          } satisfies TraceDiagnosticsErrorSummary)
        : undefined;

      if (!foundFile) {
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
