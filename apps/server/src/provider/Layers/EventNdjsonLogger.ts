// @effect-diagnostics nodeBuiltinImport:off
/**
 * Best-effort provider event logging with one shared writer store.
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

const MEBIBYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MIN_RECORD_BYTES = 256;
const DEFAULT_MAX_BYTES = 10 * MEBIBYTE;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 1_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * MEBIBYTE;
const DEFAULT_MAX_AGE_MS = 14 * DAY_MS;
const DEFAULT_RETENTION_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_BUFFERED_BYTES = MEBIBYTE;
const DEFAULT_MAX_BUFFERED_RECORDS = 512;
const DEFAULT_MAX_RECORD_BYTES = MEBIBYTE;
const DEFAULT_MAX_CACHED_SINKS = 64;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";
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
}

export interface ManagedEventNdjsonLogger extends EventNdjsonLogger {
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
  readonly maxRecordBytes?: number;
  readonly maxCachedSinks?: number;
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
  readonly maxRecordBytes: number;
  readonly maxCachedSinks: number;
}

interface PendingRecord {
  readonly threadSegment: string;
  readonly line: string;
  readonly bytes: number;
}

interface StoreState {
  readonly pending: ReadonlyArray<PendingRecord>;
  readonly pendingBytes: number;
  readonly sinks: ReadonlyMap<string, RotatingFileSink>;
  readonly closed: boolean;
  readonly lastRetentionAt: number;
  readonly retainedBytesEstimate: number;
}

interface FileOperationFailure {
  readonly filePath: string;
  readonly cause: unknown;
}

interface RetentionResult {
  readonly failures: ReadonlyArray<FileOperationFailure>;
  readonly removedCount: number;
  readonly totalBytes: number;
}

interface DrainResult {
  readonly failures: ReadonlyArray<FileOperationFailure>;
}

function logWarning(message: string, context: Record<string, unknown>) {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined) {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream) {
  return stream === "native" ? "NTIVE" : "CANON";
}

function shouldPersist(stream: EventNdjsonStream, event: unknown) {
  if (stream !== "canonical" || typeof event !== "object" || event === null) {
    return true;
  }
  const type = Reflect.get(event, "type");
  return typeof type !== "string" || !transientCanonicalEventTypes.has(type);
}

function eventType(event: unknown) {
  if (typeof event !== "object" || event === null) return null;
  const type = Reflect.get(event, "type");
  return typeof type === "string" ? type.slice(0, 128) : null;
}

function formatRecordLine(input: {
  readonly stream: EventNdjsonStream;
  readonly event: unknown;
  readonly observedAt: string;
  readonly payload: string;
  readonly maxRecordBytes: number;
}) {
  const prefix = `[${input.observedAt}] ${resolveStreamLabel(input.stream)}: `;
  const line = `${prefix}${input.payload}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes <= input.maxRecordBytes) {
    return { line, bytes };
  }

  const omittedPayload = (type: string | null) =>
    JSON.stringify({
      _tag: "ProviderEventLogRecordOmitted",
      reason: "record_too_large",
      originalBytes: bytes,
      eventType: type,
    });
  let omittedLine = `${prefix}${omittedPayload(eventType(input.event))}\n`;
  if (Buffer.byteLength(omittedLine) > input.maxRecordBytes) {
    omittedLine = `${prefix}${omittedPayload(null)}\n`;
  }
  return {
    line: omittedLine,
    bytes: Buffer.byteLength(omittedLine),
  };
}

function writeBatchedRecords(
  sink: RotatingFileSink,
  records: ReadonlyArray<PendingRecord>,
  maxChunkBytes: number,
) {
  let pendingLines: Array<string> = [];
  let pendingBytes = 0;

  const flush = () => {
    if (pendingLines.length === 0) return;
    sink.write(pendingLines.join(""));
    pendingLines = [];
    pendingBytes = 0;
  };

  for (const record of records) {
    if (pendingBytes > 0 && pendingBytes + record.bytes > maxChunkBytes) {
      flush();
    }
    pendingLines.push(record.line);
    pendingBytes += record.bytes;
    if (pendingBytes >= maxChunkBytes) {
      flush();
    }
  }
  flush();
}

function enforceRetention(input: {
  readonly directory: string;
  readonly filePattern: RegExp;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly now: number;
}): RetentionResult {
  const failures: Array<FileOperationFailure> = [];
  const files: Array<{ filePath: string; mtimeMs: number; size: number }> = [];

  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(input.directory, { withFileTypes: true });
  } catch (cause) {
    return {
      failures: [{ filePath: input.directory, cause }],
      removedCount: 0,
      totalBytes: input.maxTotalBytes + 1,
    };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !input.filePattern.test(entry.name)) continue;
    const filePath = NodePath.join(input.directory, entry.name);
    try {
      const stat = NodeFS.statSync(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (cause) {
      failures.push({ filePath, cause });
    }
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  let removedCount = 0;
  const remove = (file: (typeof files)[number]) => {
    try {
      NodeFS.rmSync(file.filePath, { force: true });
      totalBytes -= file.size;
      removedCount += 1;
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
    if (!remove(file)) break;
  }

  return { failures, removedCount, totalBytes };
}

function validateOption(input: {
  readonly filePath: string;
  readonly option: string;
  readonly value: number;
  readonly minimum: number;
}) {
  if (Number.isInteger(input.value) && input.value >= input.minimum) return undefined;
  return new EventNdjsonLogConfigurationError(input);
}

function resolveOptions(filePath: string, options: EventNdjsonLogStoreOptions) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const requestedMaxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const resolved = {
    maxBytes,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    batchWindowMs: options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    retentionCheckIntervalMs:
      options.retentionCheckIntervalMs ?? DEFAULT_RETENTION_CHECK_INTERVAL_MS,
    maxBufferedBytes,
    maxBufferedRecords: options.maxBufferedRecords ?? DEFAULT_MAX_BUFFERED_RECORDS,
    maxRecordBytes: Math.min(requestedMaxRecordBytes, maxBytes, maxBufferedBytes),
    maxCachedSinks: options.maxCachedSinks ?? DEFAULT_MAX_CACHED_SINKS,
  } satisfies ResolvedOptions;

  const validations = [
    ["maxBytes", maxBytes, MIN_RECORD_BYTES],
    ["maxFiles", resolved.maxFiles, 1],
    ["batchWindowMs", resolved.batchWindowMs, 0],
    ["maxTotalBytes", resolved.maxTotalBytes, 1],
    ["maxAgeMs", resolved.maxAgeMs, 1],
    ["retentionCheckIntervalMs", resolved.retentionCheckIntervalMs, 1],
    ["maxBufferedBytes", maxBufferedBytes, MIN_RECORD_BYTES],
    ["maxBufferedRecords", resolved.maxBufferedRecords, 1],
    ["maxRecordBytes", requestedMaxRecordBytes, MIN_RECORD_BYTES],
    ["maxCachedSinks", resolved.maxCachedSinks, 1],
  ] as const;

  for (const [option, value, minimum] of validations) {
    const error = validateOption({ filePath, option, value, minimum });
    if (error) return Effect.fail(error);
  }
  return Effect.succeed(resolved);
}

function drainPending(input: {
  readonly directory: string;
  readonly filePrefix: string;
  readonly filePattern: RegExp;
  readonly options: ResolvedOptions;
  readonly state: StoreState;
  readonly now: number;
  readonly close: boolean;
}): readonly [DrainResult, StoreState] {
  if (input.state.closed) {
    return [{ failures: [] }, input.state];
  }

  let sinks = new Map(input.state.sinks);
  const failures: Array<FileOperationFailure> = [];
  const recordsBySegment = new Map<string, Array<PendingRecord>>();

  for (const record of input.state.pending) {
    const records = recordsBySegment.get(record.threadSegment) ?? [];
    records.push(record);
    recordsBySegment.set(record.threadSegment, records);
  }

  let writtenBytes = 0;
  for (const [threadSegment, records] of recordsBySegment) {
    const filePath = NodePath.join(input.directory, `${input.filePrefix}-${threadSegment}.log`);
    let sink = sinks.get(threadSegment);
    try {
      if (!sink) {
        sink = new RotatingFileSink({
          filePath,
          maxBytes: input.options.maxBytes,
          maxFiles: input.options.maxFiles,
          throwOnError: true,
        });
      }
      sinks.delete(threadSegment);
      sinks.set(threadSegment, sink);
      while (sinks.size > input.options.maxCachedSinks) {
        const oldest = sinks.keys().next().value;
        if (oldest === undefined) break;
        sinks.delete(oldest);
      }
      writeBatchedRecords(
        sink,
        records,
        Math.min(input.options.maxBytes, input.options.maxBufferedBytes),
      );
      writtenBytes += records.reduce((total, record) => total + record.bytes, 0);
    } catch (cause) {
      sinks.delete(threadSegment);
      failures.push({ filePath, cause });
    }
  }

  const retainedBytesEstimate = input.state.retainedBytesEstimate + writtenBytes;
  const retentionDue =
    input.close ||
    failures.length > 0 ||
    retainedBytesEstimate > input.options.maxTotalBytes ||
    input.now - input.state.lastRetentionAt >= input.options.retentionCheckIntervalMs;
  const retention = retentionDue
    ? enforceRetention({
        directory: input.directory,
        filePattern: input.filePattern,
        maxTotalBytes: input.options.maxTotalBytes,
        maxAgeMs: input.options.maxAgeMs,
        now: input.now,
      })
    : null;
  if (retention && retention.removedCount > 0) {
    sinks = new Map();
  }

  return [
    {
      failures: [...failures, ...(retention?.failures ?? [])],
    },
    {
      pending: [],
      pendingBytes: 0,
      sinks,
      closed: input.close,
      lastRetentionAt: retention ? input.now : input.state.lastRetentionAt,
      retainedBytesEstimate: retention?.totalBytes ?? retainedBytesEstimate,
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
  const filePrefix =
    toSafeThreadAttachmentSegment(NodePath.parse(filePath).name) ?? "provider-events";
  const filePattern = new RegExp(`^${filePrefix}-.+\\.log(?:\\.\\d+)?$`, "u");

  yield* Effect.try({
    try: () => NodeFS.mkdirSync(directory, { recursive: true }),
    catch: (cause) => new EventNdjsonLogDirectoryError({ directory, cause }),
  });

  const initializedAt = yield* Clock.currentTimeMillis;
  const initialRetention = yield* Effect.sync(() =>
    enforceRetention({
      directory,
      filePattern,
      maxTotalBytes: resolved.maxTotalBytes,
      maxAgeMs: resolved.maxAgeMs,
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
    closed: false,
    lastRetentionAt: initializedAt,
    retainedBytesEstimate: initialRetention.totalBytes,
  });
  const timerScope = yield* Scope.make();

  const reportDrainResult = Effect.fnUntraced(function* (result: DrainResult) {
    for (const failure of result.failures) {
      yield* logWarning("provider event log write or retention failed", {
        filePath: failure.filePath,
        errorTag: errorTag(failure.cause),
      });
    }
  });

  const flush = Effect.fnUntraced(function* (close: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const result = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.sync(() =>
        drainPending({
          directory,
          filePrefix,
          filePattern,
          options: resolved,
          state,
          now,
          close,
        }),
      ),
    );
    yield* reportDrainResult(result);
  });

  if (resolved.batchWindowMs > 0) {
    yield* Effect.forkIn(
      Effect.forever(Effect.sleep(resolved.batchWindowMs).pipe(Effect.andThen(flush(false)))),
      timerScope,
      { startImmediately: true },
    );
  }

  const close = Effect.fnUntraced(function* () {
    yield* flush(true);
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
      const record = formatRecordLine({
        stream,
        event,
        observedAt,
        payload,
        maxRecordBytes: resolved.maxRecordBytes,
      });
      const now = yield* Clock.currentTimeMillis;
      const result = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
        if (state.closed) {
          return Effect.succeed([null, state] as const);
        }
        const pending = [
          ...state.pending,
          {
            threadSegment: resolveThreadSegment(threadId),
            line: record.line,
            bytes: record.bytes,
          },
        ];
        const pendingBytes = state.pendingBytes + record.bytes;
        const shouldFlush =
          resolved.batchWindowMs === 0 ||
          pending.length >= resolved.maxBufferedRecords ||
          pendingBytes >= resolved.maxBufferedBytes;
        const nextState = {
          ...state,
          pending,
          pendingBytes,
        };
        if (!shouldFlush) {
          return Effect.succeed([null, nextState] as const);
        }
        return Effect.sync(() => {
          const [drainResult, drainedState] = drainPending({
            directory,
            filePrefix,
            filePattern,
            options: resolved,
            state: nextState,
            now,
            close: false,
          });
          return [drainResult, drainedState] as const;
        });
      });
      if (result) {
        yield* reportDrainResult(result);
      }
    });

    const view = { filePath, write } satisfies EventNdjsonLogger;
    loggerViews.set(stream, view);
    return view;
  };

  return { filePath, logger, close } satisfies EventNdjsonLogStore;
});

export const makeEventNdjsonLogger = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<ManagedEventNdjsonLogger | undefined> {
  const store = yield* makeEventNdjsonLogStore(filePath, options).pipe(
    Effect.catch((error) =>
      logWarning(error.message, { error }).pipe(
        Effect.as<EventNdjsonLogStore | undefined>(undefined),
      ),
    ),
  );
  if (!store) return undefined;
  return { ...store.logger(options.stream), close: store.close };
});
