import fs from "node:fs/promises";

import type {
  ServerTraceDiagnosticsFailureSummary,
  ServerTraceDiagnosticsLogEvent,
  ServerTraceDiagnosticsRecentFailure,
  ServerTraceDiagnosticsResult,
  ServerTraceDiagnosticsSpanOccurrence,
  ServerTraceDiagnosticsSpanSummary,
} from "@t3tools/contracts";
import { Effect } from "effect";

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

interface TraceDiagnosticsOptions {
  readonly traceFilePath: string;
  readonly maxFiles: number;
  readonly slowSpanThresholdMs?: number;
  readonly readAt?: Date;
}

interface TraceDiagnosticsInput {
  readonly traceFilePath: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  readonly slowSpanThresholdMs?: number;
  readonly readAt?: Date;
}

const DEFAULT_SLOW_SPAN_THRESHOLD_MS = 1_000;
const TOP_LIMIT = 10;
const RECENT_LIMIT = 20;
function toRotatedTracePaths(traceFilePath: string, maxFiles: number): ReadonlyArray<string> {
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

function unixNanoToIso(value: unknown): string | null {
  const text = toStringValue(value);
  if (!text) return null;

  try {
    const millis = Number(BigInt(text) / 1_000_000n);
    if (!Number.isFinite(millis)) return null;
    return new Date(millis).toISOString();
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
  readonly readAt: Date;
  readonly slowSpanThresholdMs: number;
  readonly error?: ServerTraceDiagnosticsResult["error"];
}): ServerTraceDiagnosticsResult {
  return {
    traceFilePath: input.traceFilePath,
    scannedFilePaths: [...input.scannedFilePaths],
    readAt: input.readAt.toISOString(),
    recordCount: 0,
    parseErrorCount: 0,
    firstSpanAt: null,
    lastSpanAt: null,
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
    ...(input.error ? { error: input.error } : {}),
  };
}

export function aggregateTraceDiagnostics(
  input: TraceDiagnosticsInput,
): ServerTraceDiagnosticsResult {
  const readAt = input.readAt ?? new Date();
  const slowSpanThresholdMs = input.slowSpanThresholdMs ?? DEFAULT_SLOW_SPAN_THRESHOLD_MS;
  const scannedFilePaths = input.files.map((file) => file.path);
  if (input.files.length === 0) {
    return makeEmptyDiagnostics({
      traceFilePath: input.traceFilePath,
      scannedFilePaths,
      readAt,
      slowSpanThresholdMs,
      error: {
        kind: "trace-file-not-found",
        message: "No local trace files were found.",
      },
    });
  }

  let parseErrorCount = 0;
  let recordCount = 0;
  let failureCount = 0;
  let interruptionCount = 0;
  let slowSpanCount = 0;
  let firstSpanAt: string | null = null;
  let lastSpanAt: string | null = null;

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
      const endedAt = unixNanoToIso(parsed.endTimeUnixNano);
      const startedAt = unixNanoToIso(parsed.startTimeUnixNano);

      if (!name || !traceId || !spanId || durationMs === null || !endedAt) {
        parseErrorCount += 1;
        continue;
      }

      recordCount += 1;
      firstSpanAt =
        startedAt && (firstSpanAt === null || startedAt.localeCompare(firstSpanAt) < 0)
          ? startedAt
          : firstSpanAt;
      lastSpanAt = endedAt.localeCompare(lastSpanAt ?? "") > 0 ? endedAt : lastSpanAt;

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
      slowestSpans.push(spanItem);

      if (isFailure) {
        const cause = readExitCause(parsed.exit);
        latestFailures.push({ ...spanItem, cause });

        const failureKey = `${name}\0${cause}`;
        const existing = failuresByKey.get(failureKey);
        failuresByKey.set(failureKey, {
          name,
          cause,
          count: (existing?.count ?? 0) + 1,
          lastSeenAt:
            !existing || endedAt.localeCompare(existing.lastSeenAt) > 0
              ? endedAt
              : existing.lastSeenAt,
          traceId:
            !existing || endedAt.localeCompare(existing.lastSeenAt) > 0
              ? traceId
              : existing.traceId,
          spanId:
            !existing || endedAt.localeCompare(existing.lastSeenAt) > 0 ? spanId : existing.spanId,
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

          const seenAt = unixNanoToIso(rawEvent.timeUnixNano) ?? endedAt;
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
    readAt: readAt.toISOString(),
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
    slowestSpans: slowestSpans
      .toSorted((left, right) => right.durationMs - left.durationMs)
      .slice(0, TOP_LIMIT),
    commonFailures: [...failuresByKey.values()]
      .toSorted(
        (left, right) =>
          right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt),
      )
      .slice(0, TOP_LIMIT),
    latestFailures: latestFailures
      .toSorted((left, right) => right.endedAt.localeCompare(left.endedAt))
      .slice(0, RECENT_LIMIT),
    latestWarningAndErrorLogs: latestWarningAndErrorLogs
      .toSorted((left, right) => right.seenAt.localeCompare(left.seenAt))
      .slice(0, RECENT_LIMIT),
  };
}

export function readTraceDiagnostics(
  options: TraceDiagnosticsOptions,
): Effect.Effect<ServerTraceDiagnosticsResult> {
  const readAt = options.readAt ?? new Date();
  const slowSpanThresholdMs = options.slowSpanThresholdMs ?? DEFAULT_SLOW_SPAN_THRESHOLD_MS;
  const paths = toRotatedTracePaths(options.traceFilePath, options.maxFiles);

  return Effect.promise(async () => {
    const files: Array<{ path: string; text: string }> = [];
    let readFailure: string | null = null;

    for (const tracePath of paths) {
      try {
        const text = await fs.readFile(tracePath, "utf8");
        files.push({ path: tracePath, text });
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : null;
        if (code !== "ENOENT") {
          readFailure = error instanceof Error ? error.message : String(error);
        }
      }
    }

    if (readFailure) {
      return makeEmptyDiagnostics({
        traceFilePath: options.traceFilePath,
        scannedFilePaths: paths,
        readAt,
        slowSpanThresholdMs,
        error: {
          kind: "trace-file-read-failed",
          message: readFailure.trim(),
        },
      });
    }

    if (files.length === 0) {
      return makeEmptyDiagnostics({
        traceFilePath: options.traceFilePath,
        scannedFilePaths: paths,
        readAt,
        slowSpanThresholdMs,
        error: {
          kind: "trace-file-not-found",
          message: "No local trace files were found.",
        },
      });
    }

    return aggregateTraceDiagnostics({
      traceFilePath: options.traceFilePath,
      files,
      readAt,
      slowSpanThresholdMs,
    });
  });
}
