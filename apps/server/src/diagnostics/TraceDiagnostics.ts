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
import * as Schema from "effect/Schema";

export interface TraceDiagnosticsOptions {
  readonly traceFilePath: string;
  readonly maxFiles: number;
  readonly slowSpanThresholdMs?: number;
  readonly readAt?: DateTime.Utc;
}

export interface TraceDiagnosticsShape {
  readonly read: (options: TraceDiagnosticsOptions) => Effect.Effect<ServerTraceDiagnosticsResult>;
}

export class TraceDiagnostics extends Context.Service<TraceDiagnostics, TraceDiagnosticsShape>()(
  "t3/diagnostics/TraceDiagnostics",
) {}

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

const TraceExitSchema = Schema.Struct({
  _tag: Schema.optional(Schema.Unknown),
  cause: Schema.optional(Schema.Unknown),
});
type TraceExit = typeof TraceExitSchema.Type;
const decodeTraceExitOption = Schema.decodeUnknownOption(TraceExitSchema);

const TraceEventSchema = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  timeUnixNano: Schema.optional(Schema.Unknown),
  attributes: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeTraceEventOption = Schema.decodeUnknownOption(TraceEventSchema);

const TraceRecordJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.Unknown),
    traceId: Schema.optional(Schema.Unknown),
    spanId: Schema.optional(Schema.Unknown),
    startTimeUnixNano: Schema.optional(Schema.Unknown),
    endTimeUnixNano: Schema.optional(Schema.Unknown),
    durationMs: Schema.optional(Schema.Unknown),
    exit: Schema.optional(Schema.Unknown),
    events: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
);
const decodeTraceRecordJsonOption = Schema.decodeUnknownOption(TraceRecordJsonSchema);

function toRotatedTracePaths(traceFilePath: string, maxFiles: number): ReadonlyArray<string> {
  const backupCount = Math.max(0, Math.floor(maxFiles));
  const backups = Array.from(
    { length: backupCount },
    (_, index) => `${traceFilePath}.${backupCount - index}`,
  );
  return [...backups, traceFilePath];
}

function toStringOption(value: unknown): Option.Option<string> {
  return typeof value === "string" && value.trim().length > 0 ? Option.some(value) : Option.none();
}

function toNumberOption(value: unknown): Option.Option<number> {
  return typeof value === "number" && Number.isFinite(value) ? Option.some(value) : Option.none();
}

function unixNanoToDateTime(value: unknown): Option.Option<DateTime.Utc> {
  const text = toStringOption(value);
  if (Option.isNone(text)) return Option.none();
  try {
    const millis = Number(BigInt(text.value) / 1_000_000n);
    return DateTime.make(millis);
  } catch {
    return Option.none();
  }
}

function decodeTraceExit(exit: unknown): Option.Option<TraceExit> {
  return decodeTraceExitOption(exit);
}

function readExitTag(exit: unknown): Option.Option<string> {
  return Option.flatMap(decodeTraceExit(exit), (parsedExit) => toStringOption(parsedExit._tag));
}

function readExitCause(exit: unknown): string {
  return Option.getOrElse(
    Option.flatMap(decodeTraceExit(exit), (parsedExit) => toStringOption(parsedExit.cause)),
    () => "Failure",
  ).trim();
}

function minDateTimeOption(
  current: Option.Option<DateTime.Utc>,
  candidate: Option.Option<DateTime.Utc>,
): Option.Option<DateTime.Utc> {
  if (Option.isNone(candidate)) return current;
  if (Option.isNone(current)) return candidate;
  return DateTime.isLessThan(candidate.value, current.value) ? candidate : current;
}

function maxDateTime(
  current: Option.Option<DateTime.Utc>,
  candidate: DateTime.Utc,
): Option.Option<DateTime.Utc> {
  if (Option.isNone(current)) return Option.some(candidate);
  return DateTime.isGreaterThan(candidate, current.value) ? Option.some(candidate) : current;
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

function platformErrorMessage(error: PlatformError.PlatformError): string {
  return error.message || String(error);
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

  let parseErrorCount = 0;
  let recordCount = 0;
  let failureCount = 0;
  let interruptionCount = 0;
  let slowSpanCount = 0;
  let firstSpanAt = Option.none<DateTime.Utc>();
  let lastSpanAt = Option.none<DateTime.Utc>();

  const spansByName = new Map<
    string,
    { count: number; failureCount: number; totalDurationMs: number; maxDurationMs: number }
  >();
  const failuresByKey = new Map<string, ServerTraceDiagnosticsFailureSummary>();
  const latestFailures: ServerTraceDiagnosticsRecentFailure[] = [];
  const slowestSpans: ServerTraceDiagnosticsSpanOccurrence[] = [];
  const latestWarningAndErrorLogs: ServerTraceDiagnosticsLogEvent[] = [];
  const logLevelCounts: Record<string, number> = {};

  for (const file of input.files) {
    const lines = file.text.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length === 0) continue;

      const decodedRecord = decodeTraceRecordJsonOption(line);
      if (Option.isNone(decodedRecord)) {
        parseErrorCount += 1;
        continue;
      }
      const parsed = decodedRecord.value;

      const nameOption = toStringOption(parsed.name);
      const traceIdOption = toStringOption(parsed.traceId);
      const spanIdOption = toStringOption(parsed.spanId);
      const durationMsOption = toNumberOption(parsed.durationMs);
      const endedAt = unixNanoToDateTime(parsed.endTimeUnixNano);
      const startedAt = unixNanoToDateTime(parsed.startTimeUnixNano);

      if (
        Option.isNone(nameOption) ||
        Option.isNone(traceIdOption) ||
        Option.isNone(spanIdOption) ||
        Option.isNone(durationMsOption) ||
        Option.isNone(endedAt)
      ) {
        parseErrorCount += 1;
        continue;
      }
      const name = nameOption.value;
      const traceId = traceIdOption.value;
      const spanId = spanIdOption.value;
      const durationMs = durationMsOption.value;

      recordCount += 1;
      firstSpanAt = minDateTimeOption(firstSpanAt, startedAt);
      lastSpanAt = maxDateTime(lastSpanAt, endedAt.value);

      const exitTag = readExitTag(parsed.exit);
      const isFailure = Option.contains(exitTag, "Failure");
      const isInterrupted = Option.contains(exitTag, "Interrupted");
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

      const spanItem = { name, durationMs, endedAt: endedAt.value, traceId, spanId };
      if (durationMs >= slowSpanThresholdMs) {
        slowSpanCount += 1;
      }
      insertBoundedSlowestSpan(slowestSpans, spanItem);

      if (isFailure) {
        const cause = readExitCause(parsed.exit);
        latestFailures.push({ ...spanItem, cause });

        const failureKey = `${name}\0${cause}`;
        const existing = failuresByKey.get(failureKey);
        const isLatestFailure =
          !existing || DateTime.isGreaterThan(endedAt.value, existing.lastSeenAt);
        failuresByKey.set(failureKey, {
          name,
          cause,
          count: (existing?.count ?? 0) + 1,
          lastSeenAt: isLatestFailure ? endedAt.value : existing!.lastSeenAt,
          traceId: isLatestFailure ? traceId : existing!.traceId,
          spanId: isLatestFailure ? spanId : existing!.spanId,
        });
      }

      if (Array.isArray(parsed.events)) {
        for (const rawEvent of parsed.events) {
          const event = decodeTraceEventOption(rawEvent);
          if (Option.isNone(event)) continue;
          const attributes = Option.getOrElse(
            Option.fromUndefinedOr(event.value.attributes),
            () => ({}) as Readonly<Record<string, unknown>>,
          );
          const levelOption = toStringOption(attributes["effect.logLevel"]);
          if (Option.isNone(levelOption)) continue;
          const level = levelOption.value;

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

          const seenAt = Option.getOrElse(
            unixNanoToDateTime(event.value.timeUnixNano),
            () => endedAt.value,
          );
          const message = Option.getOrElse(
            Option.map(toStringOption(event.value.name), (name) => name.trim()),
            () => "Log event",
          );
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
  }

  const topSpansByCount: ServerTraceDiagnosticsSpanSummary[] = [...spansByName.entries()]
    .map(([name, span]) => ({
      name,
      count: span.count,
      failureCount: span.failureCount,
      totalDurationMs: span.totalDurationMs,
      averageDurationMs: span.count > 0 ? span.totalDurationMs / span.count : 0,
      maxDurationMs: span.maxDurationMs,
    }))
    .toSorted((left, right) => right.count - left.count || right.maxDurationMs - left.maxDurationMs)
    .slice(0, TOP_LIMIT);

  return {
    traceFilePath: input.traceFilePath,
    scannedFilePaths,
    readAt,
    recordCount,
    parseErrorCount,
    firstSpanAt,
    lastSpanAt,
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
        (left, right) => DateTime.toEpochMillis(right.seenAt) - DateTime.toEpochMillis(left.seenAt),
      )
      .slice(0, RECENT_LIMIT),
    partialFailure: input.partialFailure ? Option.some(true) : Option.none(),
    error: Option.fromNullishOr(input.error),
  };
}

type TraceFileReadResult =
  | { readonly _tag: "Loaded"; readonly path: string; readonly text: string }
  | { readonly _tag: "Missing"; readonly path: string }
  | { readonly _tag: "Failed"; readonly path: string; readonly message: string };

function readTraceFile(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<TraceFileReadResult> {
  return fileSystem.readFileString(path).pipe(
    Effect.map((text) => ({ _tag: "Loaded" as const, path, text })),
    Effect.catch((error: PlatformError.PlatformError) =>
      Effect.succeed(
        isNotFoundError(error)
          ? { _tag: "Missing" as const, path }
          : { _tag: "Failed" as const, path, message: platformErrorMessage(error) },
      ),
    ),
  );
}

export const make = Effect.fn("makeTraceDiagnostics")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  const read: TraceDiagnosticsShape["read"] = Effect.fn("TraceDiagnostics.read")(
    function* (options) {
      const readAt = options.readAt ?? (yield* DateTime.now);
      const slowSpanThresholdMs = options.slowSpanThresholdMs ?? DEFAULT_SLOW_SPAN_THRESHOLD_MS;
      const paths = toRotatedTracePaths(options.traceFilePath, options.maxFiles);
      const results = yield* Effect.all(
        paths.map((path) => readTraceFile(fileSystem, path)),
        {
          concurrency: 1,
        },
      );
      const files = results.flatMap((result) =>
        result._tag === "Loaded" ? [{ path: result.path, text: result.text }] : [],
      );
      const readFailure = results.find((result) => result._tag === "Failed");
      const readFailureError = readFailure
        ? ({
            kind: "trace-file-read-failed",
            message: readFailure.message.trim() || `Failed to read ${readFailure.path}.`,
          } satisfies TraceDiagnosticsErrorSummary)
        : undefined;

      if (files.length === 0) {
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

      return aggregateTraceDiagnostics({
        traceFilePath: options.traceFilePath,
        files,
        scannedFilePaths: paths,
        readAt,
        slowSpanThresholdMs,
        ...(readFailureError ? { partialFailure: true, error: readFailureError } : {}),
      });
    },
  );

  return TraceDiagnostics.of({ read });
});

export const layer = Layer.effect(TraceDiagnostics, make());

export function readTraceDiagnostics(
  options: TraceDiagnosticsOptions,
): Effect.Effect<ServerTraceDiagnosticsResult, never, TraceDiagnostics> {
  return Effect.gen(function* () {
    const diagnostics = yield* TraceDiagnostics;
    return yield* diagnostics.read(options);
  });
}
