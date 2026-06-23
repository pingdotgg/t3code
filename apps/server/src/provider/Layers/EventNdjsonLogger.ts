// @effect-diagnostics nodeBuiltinImport:off
/**
 * Best-effort provider event logging with one shared writer per thread.
 *
 * Native and canonical views share batching, rotation, and retention state so
 * they cannot race while appending to the same thread-scoped file.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { errorTag } from "@t3tools/shared/observability";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import type { ResourceAttributionShape } from "../../resourceTelemetry/ResourceAttribution.ts";

const MEBIBYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 10 * MEBIBYTE;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 1_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * MEBIBYTE;
const DEFAULT_MAX_AGE_MS = 14 * DAY_MS;
const DEFAULT_RETENTION_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_BUFFERED_BYTES = MEBIBYTE;
const DEFAULT_MAX_BUFFERED_RECORDS = 512;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";
const PROVIDER_LOG_FILE_PATTERN = /\.log(?:\.\d+)?$/u;
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

const transientCanonicalEventTypes = new Set([
  "content.delta",
  "hook.progress",
  "item.updated",
  "task.progress",
  "thread.realtime.audio.delta",
  "tool.progress",
  "turn.proposed.delta",
]);

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  readonly write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStore {
  readonly filePath: string;
  readonly logger: (stream: EventNdjsonStream) => EventNdjsonLogger;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStoreOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
  readonly maxTotalBytes?: number;
  readonly maxAgeMs?: number;
  readonly retentionCheckIntervalMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedRecords?: number;
  readonly attribution?: ResourceAttributionShape;
}

export interface EventNdjsonLoggerOptions extends EventNdjsonLogStoreOptions {
  readonly stream: EventNdjsonStream;
}

export class EventNdjsonLogConfigurationError extends Schema.TaggedErrorClass<EventNdjsonLogConfigurationError>()(
  "EventNdjsonLogConfigurationError",
  {
    filePath: Schema.String,
    option: Schema.String,
    value: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider event log option '${this.option}' must be an integer >= ${this.minimum}; received ${this.value} for '${this.filePath}'`;
  }
}

export class EventNdjsonLogDirectoryError extends Schema.TaggedErrorClass<EventNdjsonLogDirectoryError>()(
  "EventNdjsonLogDirectoryError",
  {
    directory: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create provider event log directory '${this.directory}'`;
  }
}

export type EventNdjsonLogStoreError =
  | EventNdjsonLogConfigurationError
  | EventNdjsonLogDirectoryError;

interface ResolvedOptions {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly retentionCheckIntervalMs: number;
  readonly maxBufferedBytes: number;
  readonly maxBufferedRecords: number;
  readonly attribution: ResourceAttributionShape | undefined;
}

interface PendingRecord {
  readonly stream: EventNdjsonStream;
  readonly threadSegment: string;
  readonly line: string;
  readonly bytes: number;
}

interface StoreState {
  readonly pending: ReadonlyArray<PendingRecord>;
  readonly pendingBytes: number;
  readonly sinks: ReadonlyMap<string, RotatingFileSink>;
  readonly failedSegments: ReadonlySet<string>;
  readonly flushScheduled: boolean;
  readonly closed: boolean;
  readonly lastRetentionAt: number;
}

interface AttributionSummary {
  readonly stream: EventNdjsonStream;
  readonly count: number;
  readonly logicalWriteBytes: number;
}

interface FileOperationFailure {
  readonly filePath: string;
  readonly cause: unknown;
}

interface RetentionResult {
  readonly failures: ReadonlyArray<FileOperationFailure>;
}

interface DrainResult {
  readonly attributions: ReadonlyArray<AttributionSummary>;
  readonly failures: ReadonlyArray<FileOperationFailure>;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  return stream === "native" ? "NTIVE" : "CANON";
}

function shouldPersist(stream: EventNdjsonStream, event: unknown): boolean {
  if (stream !== "canonical" || typeof event !== "object" || event === null) {
    return true;
  }
  const type = Reflect.get(event, "type");
  return typeof type !== "string" || !transientCanonicalEventTypes.has(type);
}

function writeBatchedMessages(
  sink: RotatingFileSink,
  records: ReadonlyArray<PendingRecord>,
  maxBytes: number,
): void {
  let pendingLines: Array<string> = [];
  let pendingBytes = 0;

  const flush = () => {
    if (pendingLines.length === 0) return;
    sink.write(pendingLines.join(""));
    pendingLines = [];
    pendingBytes = 0;
  };

  for (const record of records) {
    if (pendingBytes > 0 && pendingBytes + record.bytes > maxBytes) {
      flush();
    }
    pendingLines.push(record.line);
    pendingBytes += record.bytes;
    if (pendingBytes >= maxBytes) {
      flush();
    }
  }
  flush();
}

function enforceRetention(input: {
  readonly directory: string;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly activeFilePaths: ReadonlySet<string>;
  readonly now: number;
}): RetentionResult {
  const failures: Array<FileOperationFailure> = [];
  const files: Array<{ filePath: string; mtimeMs: number; size: number }> = [];

  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(input.directory, { withFileTypes: true });
  } catch (cause) {
    return { failures: [{ filePath: input.directory, cause }] };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !PROVIDER_LOG_FILE_PATTERN.test(entry.name)) continue;
    const filePath = NodePath.join(input.directory, entry.name);
    try {
      const stat = NodeFS.statSync(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (cause) {
      failures.push({ filePath, cause });
    }
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  const remove = (file: (typeof files)[number]) => {
    if (input.activeFilePaths.has(file.filePath)) return false;
    try {
      NodeFS.rmSync(file.filePath, { force: true });
      totalBytes -= file.size;
      return true;
    } catch (cause) {
      failures.push({ filePath: file.filePath, cause });
      return false;
    }
  };

  const retained = files.filter((file) => {
    if (input.now - file.mtimeMs <= input.maxAgeMs) return true;
    return !remove(file);
  });

  for (const file of retained.toSorted(
    (left, right) => left.mtimeMs - right.mtimeMs || left.filePath.localeCompare(right.filePath),
  )) {
    if (totalBytes <= input.maxTotalBytes) break;
    remove(file);
  }

  return { failures };
}

function validateOption(input: {
  readonly filePath: string;
  readonly option: string;
  readonly value: number;
  readonly minimum: number;
}): EventNdjsonLogConfigurationError | undefined {
  if (Number.isInteger(input.value) && input.value >= input.minimum) return undefined;
  return new EventNdjsonLogConfigurationError(input);
}

function resolveOptions(
  filePath: string,
  options: EventNdjsonLogStoreOptions,
): Effect.Effect<ResolvedOptions, EventNdjsonLogConfigurationError> {
  const resolved = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    batchWindowMs: options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    retentionCheckIntervalMs:
      options.retentionCheckIntervalMs ?? DEFAULT_RETENTION_CHECK_INTERVAL_MS,
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    maxBufferedRecords: options.maxBufferedRecords ?? DEFAULT_MAX_BUFFERED_RECORDS,
    attribution: options.attribution,
  } satisfies ResolvedOptions;

  const validations = [
    ["maxBytes", resolved.maxBytes, 1],
    ["maxFiles", resolved.maxFiles, 1],
    ["batchWindowMs", resolved.batchWindowMs, 0],
    ["maxTotalBytes", resolved.maxTotalBytes, 1],
    ["maxAgeMs", resolved.maxAgeMs, 1],
    ["retentionCheckIntervalMs", resolved.retentionCheckIntervalMs, 1],
    ["maxBufferedBytes", resolved.maxBufferedBytes, 1],
    ["maxBufferedRecords", resolved.maxBufferedRecords, 1],
  ] as const;

  for (const [option, value, minimum] of validations) {
    const error = validateOption({ filePath, option, value, minimum });
    if (error) return Effect.fail(error);
  }
  return Effect.succeed(resolved);
}

function drainPending(input: {
  readonly directory: string;
  readonly options: ResolvedOptions;
  readonly state: StoreState;
  readonly now: number;
  readonly timerFired: boolean;
  readonly close: boolean;
}): readonly [DrainResult, StoreState] {
  if (input.state.closed) {
    return [{ attributions: [], failures: [] }, input.state];
  }

  const sinks = new Map(input.state.sinks);
  const failedSegments = new Set(input.state.failedSegments);
  const failures: Array<FileOperationFailure> = [];
  const attributionByStream = new Map<
    EventNdjsonStream,
    { count: number; logicalWriteBytes: number }
  >();
  const recordsBySegment = new Map<string, Array<PendingRecord>>();

  for (const record of input.state.pending) {
    const records = recordsBySegment.get(record.threadSegment) ?? [];
    records.push(record);
    recordsBySegment.set(record.threadSegment, records);
  }

  for (const [threadSegment, records] of recordsBySegment) {
    if (failedSegments.has(threadSegment)) continue;
    const filePath = NodePath.join(input.directory, `${threadSegment}.log`);
    let sink = sinks.get(threadSegment);
    if (!sink) {
      try {
        sink = new RotatingFileSink({
          filePath,
          maxBytes: input.options.maxBytes,
          maxFiles: input.options.maxFiles,
          throwOnError: true,
        });
        sinks.set(threadSegment, sink);
      } catch (cause) {
        failedSegments.add(threadSegment);
        failures.push({ filePath, cause });
        continue;
      }
    }

    try {
      writeBatchedMessages(sink, records, input.options.maxBytes);
      for (const record of records) {
        const current = attributionByStream.get(record.stream) ?? {
          count: 0,
          logicalWriteBytes: 0,
        };
        attributionByStream.set(record.stream, {
          count: current.count + 1,
          logicalWriteBytes: current.logicalWriteBytes + record.bytes,
        });
      }
    } catch (cause) {
      failedSegments.add(threadSegment);
      failures.push({ filePath, cause });
    }
  }

  const retentionDue =
    input.now - input.state.lastRetentionAt >= input.options.retentionCheckIntervalMs;
  const retention = retentionDue
    ? enforceRetention({
        directory: input.directory,
        maxTotalBytes: input.options.maxTotalBytes,
        maxAgeMs: input.options.maxAgeMs,
        activeFilePaths: new Set(
          Array.from(sinks.keys(), (threadSegment) =>
            NodePath.join(input.directory, `${threadSegment}.log`),
          ),
        ),
        now: input.now,
      })
    : { failures: [] };

  return [
    {
      attributions: Array.from(attributionByStream, ([stream, value]) => ({
        stream,
        ...value,
      })),
      failures: [...failures, ...retention.failures],
    },
    {
      pending: [],
      pendingBytes: 0,
      sinks,
      failedSegments,
      flushScheduled: input.timerFired ? false : input.state.flushScheduled,
      closed: input.close,
      lastRetentionAt: retentionDue ? input.now : input.state.lastRetentionAt,
    },
  ];
}

const serializeEvent = Effect.fnUntraced(function* (event: unknown) {
  return yield* encodeUnknownJsonString(event).pipe(
    Effect.catch((error) =>
      logWarning("failed to serialize provider event log record", {
        errorTag: errorTag(error),
      }).pipe(Effect.as(undefined)),
    ),
  );
});

export const makeEventNdjsonLogStore = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLogStoreOptions = {},
): Effect.fn.Return<EventNdjsonLogStore, EventNdjsonLogStoreError> {
  const resolved = yield* resolveOptions(filePath, options);
  const directory = NodePath.dirname(filePath);

  yield* Effect.try({
    try: () => NodeFS.mkdirSync(directory, { recursive: true }),
    catch: (cause) => new EventNdjsonLogDirectoryError({ directory, cause }),
  });

  const initializedAt = yield* Clock.currentTimeMillis;
  const initialRetention = yield* Effect.sync(() =>
    enforceRetention({
      directory,
      maxTotalBytes: resolved.maxTotalBytes,
      maxAgeMs: resolved.maxAgeMs,
      activeFilePaths: new Set(),
      now: initializedAt,
    }),
  );
  for (const failure of initialRetention.failures) {
    yield* logWarning("provider event log retention failed", {
      filePath: failure.filePath,
      errorTag: errorTag(failure.cause),
    });
  }

  const stateRef = yield* SynchronizedRef.make<StoreState>({
    pending: [],
    pendingBytes: 0,
    sinks: new Map(),
    failedSegments: new Set(),
    flushScheduled: false,
    closed: false,
    lastRetentionAt: initializedAt,
  });
  const timerScope = yield* Scope.make();

  const flush = Effect.fnUntraced(function* (timerFired: boolean, close: boolean) {
    const startedAt = yield* Clock.currentTimeMillis;
    const result = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.sync(() =>
        drainPending({
          directory,
          options: resolved,
          state,
          now: startedAt,
          timerFired,
          close,
        }),
      ),
    );

    for (const failure of result.failures) {
      yield* logWarning("provider event log write or retention failed", {
        filePath: failure.filePath,
        errorTag: errorTag(failure.cause),
      });
    }

    if (resolved.attribution && result.attributions.length > 0) {
      const completedAt = yield* Clock.currentTimeMillis;
      const durationMs = Math.max(0, completedAt - startedAt);
      const totalBytes = result.attributions.reduce(
        (total, entry) => total + entry.logicalWriteBytes,
        0,
      );
      yield* Effect.forEach(
        result.attributions,
        (entry) =>
          resolved.attribution?.record({
            component: "provider-event-log",
            operation: `${entry.stream}.append`,
            logicalWriteBytes: entry.logicalWriteBytes,
            count: entry.count,
            durationMs:
              totalBytes === 0
                ? 0
                : Math.round(durationMs * (entry.logicalWriteBytes / totalBytes)),
          }) ?? Effect.void,
        { discard: true },
      );
    }
  });

  const scheduleFlush = Effect.fnUntraced(function* () {
    yield* Effect.forkIn(
      Effect.sleep(resolved.batchWindowMs).pipe(Effect.andThen(flush(true, false))),
      timerScope,
      { startImmediately: true },
    );
  });

  const close = Effect.fnUntraced(function* () {
    yield* flush(false, true);
    yield* Scope.close(timerScope, Exit.void);
  });

  const loggerViews = new Map<EventNdjsonStream, EventNdjsonLogger>();
  const logger = (stream: EventNdjsonStream): EventNdjsonLogger => {
    const existing = loggerViews.get(stream);
    if (existing) return existing;

    const write = Effect.fnUntraced(function* (event: unknown, threadId: ThreadId | null) {
      if (!shouldPersist(stream, event)) return;
      const payload = yield* serializeEvent(event);
      if (payload === undefined) return;

      const observedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const line = `[${observedAt}] ${resolveStreamLabel(stream)}: ${payload}\n`;
      const bytes = Buffer.byteLength(line);
      const action = yield* SynchronizedRef.modify(stateRef, (state) => {
        if (state.closed) {
          return [{ flush: false, schedule: false }, state] as const;
        }
        const pending = [
          ...state.pending,
          { stream, threadSegment: resolveThreadSegment(threadId), line, bytes },
        ];
        const pendingBytes = state.pendingBytes + bytes;
        const flush =
          resolved.batchWindowMs === 0 ||
          pending.length >= resolved.maxBufferedRecords ||
          pendingBytes >= resolved.maxBufferedBytes;
        const schedule = !flush && !state.flushScheduled;
        return [
          { flush, schedule },
          {
            ...state,
            pending,
            pendingBytes,
            flushScheduled: state.flushScheduled || schedule,
          },
        ] as const;
      });

      if (action.flush) {
        yield* flush(false, false);
      } else if (action.schedule) {
        yield* scheduleFlush();
      }
    });

    const view = { filePath, write, close } satisfies EventNdjsonLogger;
    loggerViews.set(stream, view);
    return view;
  };

  return { filePath, logger, close } satisfies EventNdjsonLogStore;
});

export const makeEventNdjsonLogger = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const store = yield* makeEventNdjsonLogStore(filePath, options).pipe(
    Effect.catch((error) =>
      logWarning(error.message, { error }).pipe(
        Effect.as<EventNdjsonLogStore | undefined>(undefined),
      ),
    ),
  );
  return store?.logger(options.stream);
});
