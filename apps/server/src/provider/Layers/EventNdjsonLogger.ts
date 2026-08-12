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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import type { ResourceAttribution } from "../../resourceTelemetry/ResourceAttribution.ts";

const MEBIBYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 10 * MEBIBYTE;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 1_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * MEBIBYTE;
const DEFAULT_MAX_AGE_MS = 14 * DAY_MS;
const DEFAULT_RETENTION_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
// Leave room for ordinary provider bursts while keeping a hard ceiling during
// a sustained filesystem/antivirus stall. The one-second batch window still
// controls normal write latency; these values are backlog limits, not targets.
const DEFAULT_MAX_BUFFERED_BYTES = 16 * MEBIBYTE;
const DEFAULT_MAX_BUFFERED_RECORDS = 16_384;
const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

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
  readonly attribution?: ResourceAttribution["Service"];
  readonly onDrain?: () => Effect.Effect<void>;
  readonly writeAsync?: (filePath: string, chunk: string | Buffer) => Promise<void>;
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
  readonly attribution: ResourceAttribution["Service"] | undefined;
  readonly onDrain: (() => Effect.Effect<void>) | undefined;
  readonly writeAsync: ((filePath: string, chunk: string | Buffer) => Promise<void>) | undefined;
}

export interface PendingRecord {
  readonly stream: EventNdjsonStream;
  readonly threadSegment: string;
  readonly line: string;
  readonly bytes: number;
}

interface StoreState {
  readonly pending: ReadonlyArray<PendingRecord>;
  readonly pendingBytes: number;
  readonly bufferedRecords: number;
  readonly bufferedBytes: number;
  readonly sinks: ReadonlyMap<string, RotatingFileSink>;
  readonly flushScheduled: boolean;
  readonly workerRunning: boolean;
  readonly overflowReported: boolean;
  readonly closed: boolean;
  readonly lastRetentionAt: number;
}

interface DrainSnapshot {
  readonly records: ReadonlyArray<PendingRecord>;
  readonly sinks: ReadonlyMap<string, RotatingFileSink>;
  readonly lastRetentionAt: number;
}

interface DrainedState {
  readonly sinks: ReadonlyMap<string, RotatingFileSink>;
  readonly lastRetentionAt: number;
}

interface WorkerTake {
  readonly snapshot: DrainSnapshot | undefined;
  readonly closed: boolean;
}

interface CloseAction {
  readonly first: boolean;
  readonly startWorker: boolean;
}

interface WriteAction {
  readonly reportOverflow: boolean;
  readonly scheduleFlush: boolean;
  readonly startWorker: boolean;
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
  readonly failedRecords: ReadonlyArray<PendingRecord>;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  return stream === "native" ? "NTIVE" : stream === "orchestration" ? "ORCH" : "CANON";
}

function providerLogPrefix(filePath: string): string {
  const basename = NodePath.basename(filePath);
  const extension = NodePath.extname(basename);
  return `${extension.length > 0 ? basename.slice(0, -extension.length) : basename}.`;
}

function providerLogPath(directory: string, prefix: string, threadSegment: string): string {
  return NodePath.join(directory, `${prefix}${threadSegment}.log`);
}

function shouldPersist(stream: EventNdjsonStream, event: unknown): boolean {
  if (stream !== "canonical" || typeof event !== "object" || event === null) {
    return true;
  }
  try {
    const type = Reflect.get(event, "type");
    return typeof type !== "string" || !transientCanonicalEventTypes.has(type);
  } catch {
    return true;
  }
}

export async function writeBatchedMessages(
  sink: Pick<RotatingFileSink, "writeAsync">,
  records: ReadonlyArray<PendingRecord>,
  maxBytes: number,
  onWritten: (records: ReadonlyArray<PendingRecord>) => void,
): Promise<void> {
  let pendingRecords: Array<PendingRecord> = [];
  let pendingBytes = 0;

  const flush = async () => {
    if (pendingRecords.length === 0) return;
    const writtenRecords = pendingRecords;
    await sink.writeAsync(writtenRecords.map((record) => record.line).join(""));
    onWritten(writtenRecords);
    pendingRecords = [];
    pendingBytes = 0;
  };

  for (const record of records) {
    if (pendingBytes > 0 && pendingBytes + record.bytes > maxBytes) {
      await flush();
    }
    pendingRecords.push(record);
    pendingBytes += record.bytes;
    if (pendingBytes >= maxBytes) {
      await flush();
    }
  }
  await flush();
}

function isProviderLogFile(filePath: string, fileName: string, filePrefix: string): boolean {
  if (!/\.log(?:\.\d+)?$/u.test(fileName)) return false;
  if (fileName.startsWith(filePrefix)) return true;

  const descriptor = NodeFS.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(256);
    const bytesRead = NodeFS.readSync(descriptor, header, 0, header.byteLength, 0);
    return /^\[[^\]\r\n]+\] (?:NTIVE|CANON|ORCH): /u.test(header.toString("utf8", 0, bytesRead));
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

function enforceRetention(input: {
  readonly directory: string;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly activeFilePaths: ReadonlySet<string>;
  readonly filePrefix: string;
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
    if (!entry.isFile()) continue;
    const filePath = NodePath.join(input.directory, entry.name);
    try {
      if (!isProviderLogFile(filePath, entry.name, input.filePrefix)) continue;
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
    onDrain: options.onDrain,
    writeAsync: options.writeAsync,
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

async function drainPending(input: {
  readonly directory: string;
  readonly options: ResolvedOptions;
  readonly snapshot: DrainSnapshot;
  readonly filePrefix: string;
  readonly now: number;
}): Promise<readonly [DrainResult, DrainedState]> {
  const sinks = new Map(input.snapshot.sinks);
  const failures: Array<FileOperationFailure> = [];
  const failedRecordSet = new Set<PendingRecord>();
  const attributionByStream = new Map<
    EventNdjsonStream,
    { count: number; logicalWriteBytes: number }
  >();
  const recordsBySegment = new Map<string, Array<PendingRecord>>();

  for (const record of input.snapshot.records) {
    const records = recordsBySegment.get(record.threadSegment) ?? [];
    records.push(record);
    recordsBySegment.set(record.threadSegment, records);
  }

  for (const [threadSegment, records] of recordsBySegment) {
    const filePath = providerLogPath(input.directory, input.filePrefix, threadSegment);
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
        failures.push({ filePath, cause });
        for (const record of records) failedRecordSet.add(record);
        continue;
      }
    }

    const writtenRecordSet = new Set<PendingRecord>();
    try {
      const writeSink = input.options.writeAsync
        ? {
            writeAsync: (chunk: string | Buffer) =>
              input.options.writeAsync?.(filePath, chunk) ?? Promise.resolve(),
          }
        : sink;
      await writeBatchedMessages(writeSink, records, input.options.maxBytes, (written) => {
        for (const record of written) {
          writtenRecordSet.add(record);
          const current = attributionByStream.get(record.stream) ?? {
            count: 0,
            logicalWriteBytes: 0,
          };
          attributionByStream.set(record.stream, {
            count: current.count + 1,
            logicalWriteBytes: current.logicalWriteBytes + record.bytes,
          });
        }
      });
    } catch (cause) {
      sinks.delete(threadSegment);
      failures.push({ filePath, cause });
      for (const record of records) {
        if (!writtenRecordSet.has(record)) failedRecordSet.add(record);
      }
    }
  }

  const retentionDue =
    input.now - input.snapshot.lastRetentionAt >= input.options.retentionCheckIntervalMs;
  const activeThreadSegments = new Set([...input.snapshot.sinks.keys(), ...sinks.keys()]);
  const retention = retentionDue
    ? enforceRetention({
        directory: input.directory,
        maxTotalBytes: input.options.maxTotalBytes,
        maxAgeMs: input.options.maxAgeMs,
        activeFilePaths: new Set(
          Array.from(activeThreadSegments, (threadSegment) =>
            providerLogPath(input.directory, input.filePrefix, threadSegment),
          ),
        ),
        filePrefix: input.filePrefix,
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
      failedRecords: input.snapshot.records.filter((record) => failedRecordSet.has(record)),
    },
    {
      sinks,
      lastRetentionAt: retentionDue ? input.now : input.snapshot.lastRetentionAt,
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
  const filePrefix = providerLogPrefix(filePath);

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
      filePrefix,
      now: initializedAt,
    }),
  );
  for (const failure of initialRetention.failures) {
    yield* logWarning("provider event log retention failed", {
      filePath: failure.filePath,
      errorTag: errorTag(failure.cause),
    });
  }

  const stateRef = yield* Ref.make<StoreState>({
    pending: [],
    pendingBytes: 0,
    bufferedRecords: 0,
    bufferedBytes: 0,
    sinks: new Map(),
    flushScheduled: false,
    workerRunning: false,
    overflowReported: false,
    closed: false,
    lastRetentionAt: initializedAt,
  });
  const timerScope = yield* Scope.make();
  const drainCompleted = yield* Deferred.make<void>();
  const closeCompleted = yield* Deferred.make<void>();

  const reportDrain = Effect.fnUntraced(function* (result: DrainResult, startedAt: number) {
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
    if (resolved.onDrain && (result.attributions.length > 0 || result.failures.length > 0)) {
      yield* resolved.onDrain();
    }
  });

  const worker = Effect.gen(function* () {
    let retryDelayMs = MIN_RETRY_DELAY_MS;
    while (true) {
      const next = yield* Ref.modify(stateRef, (state): readonly [WorkerTake, StoreState] => {
        if (state.pending.length === 0) {
          return [
            { snapshot: undefined, closed: state.closed },
            { ...state, workerRunning: false },
          ] as const;
        }

        return [
          {
            snapshot: {
              records: state.pending,
              sinks: state.sinks,
              lastRetentionAt: state.lastRetentionAt,
            },
            closed: false,
          },
          {
            ...state,
            pending: [],
            pendingBytes: 0,
          },
        ] as const;
      });

      if (next.snapshot === undefined) {
        if (next.closed) {
          yield* Deferred.succeed(drainCompleted, undefined);
        }
        return;
      }

      const snapshot = next.snapshot;
      const startedAt = yield* Clock.currentTimeMillis;
      const drainExit = yield* Effect.promise(() =>
        drainPending({
          directory,
          options: resolved,
          snapshot,
          filePrefix,
          now: startedAt,
        }),
      ).pipe(Effect.exit);
      const [result, drainedState] = Exit.isSuccess(drainExit)
        ? drainExit.value
        : [
            {
              attributions: [],
              failures: [],
              failedRecords: snapshot.records,
            },
            {
              sinks: snapshot.sinks,
              lastRetentionAt: snapshot.lastRetentionAt,
            },
          ];

      if (!Exit.isSuccess(drainExit)) {
        yield* logWarning("provider event log drain failed", {
          errorTag: errorTag(drainExit.cause),
        });
      }

      const retry = yield* Ref.modify(stateRef, (state) => {
        const retryRecords = state.closed ? [] : result.failedRecords;
        const retryBytes = retryRecords.reduce((total, record) => total + record.bytes, 0);
        const completedRecords = snapshot.records.length - retryRecords.length;
        const completedBytes =
          snapshot.records.reduce((total, record) => total + record.bytes, 0) - retryBytes;
        return [
          retryRecords.length > 0,
          {
            ...state,
            ...drainedState,
            pending: [...retryRecords, ...state.pending],
            pendingBytes: state.pendingBytes + retryBytes,
            bufferedRecords: Math.max(0, state.bufferedRecords - completedRecords),
            bufferedBytes: Math.max(0, state.bufferedBytes - completedBytes),
            overflowReported:
              completedRecords === 0 && completedBytes === 0 ? state.overflowReported : false,
          },
        ] as const;
      });
      yield* reportDrain(result, startedAt).pipe(
        Effect.catchCause((cause) =>
          logWarning("provider event log drain reporting failed", {
            errorTag: errorTag(cause),
          }),
        ),
      );
      if (retry) {
        yield* Effect.sleep(retryDelayMs);
        retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * 2);
      } else {
        retryDelayMs = MIN_RETRY_DELAY_MS;
      }
    }
  }).pipe(Effect.uninterruptible);

  const startWorker = Effect.forkIn(worker, timerScope, { startImmediately: true }).pipe(
    Effect.asVoid,
  );

  const scheduleFlush = Effect.forkIn(
    Effect.sleep(resolved.batchWindowMs).pipe(
      Effect.andThen(
        Ref.modify(stateRef, (state) => {
          const nextState = { ...state, flushScheduled: false };
          if (state.closed || state.workerRunning || state.pending.length === 0) {
            return [false, nextState] as const;
          }
          return [true, { ...nextState, workerRunning: true }] as const;
        }),
      ),
      Effect.flatMap((start) => (start ? startWorker : Effect.void)),
    ),
    timerScope,
    { startImmediately: true },
  ).pipe(Effect.asVoid);

  const superviseClose = Deferred.await(drainCompleted).pipe(
    Effect.timeoutOption("2 seconds"),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          // Release callers at the deadline, but keep the detached best-effort
          // worker alive so a late filesystem completion can clean up its scope.
          Deferred.succeed(closeCompleted, undefined).pipe(
            Effect.andThen(Deferred.await(drainCompleted)),
            Effect.andThen(Scope.close(timerScope, Exit.void)),
          ),
        onSome: () =>
          Scope.close(timerScope, Exit.void).pipe(
            Effect.andThen(Deferred.succeed(closeCompleted, undefined)),
          ),
      }),
    ),
  );

  const close = Effect.fnUntraced(function* () {
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const action = yield* Ref.modify(stateRef, (state): readonly [CloseAction, StoreState] => {
          if (state.closed) {
            return [{ first: false, startWorker: false }, state] as const;
          }
          const start = !state.workerRunning;
          return [
            { first: true, startWorker: start },
            {
              ...state,
              closed: true,
              workerRunning: state.workerRunning || start,
            },
          ] as const;
        });
        if (action.startWorker) {
          yield* startWorker;
        }
        if (action.first) {
          yield* superviseClose.pipe(Effect.forkDetach);
        }
        yield* restore(Deferred.await(closeCompleted));
      }),
    );
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
      const action = yield* Effect.uninterruptible(
        Ref.modify(stateRef, (state): readonly [WriteAction, StoreState] => {
          if (state.closed) {
            return [
              { reportOverflow: false, scheduleFlush: false, startWorker: false },
              state,
            ] as const;
          }
          if (
            state.bufferedRecords >= resolved.maxBufferedRecords ||
            state.bufferedBytes + bytes > resolved.maxBufferedBytes
          ) {
            const start = !state.workerRunning && state.pending.length > 0;
            return [
              {
                reportOverflow: !state.overflowReported,
                scheduleFlush: false,
                startWorker: start,
              },
              {
                ...state,
                workerRunning: state.workerRunning || start,
                overflowReported: true,
              },
            ] as const;
          }
          // The Ref owns this array until the worker atomically detaches it.
          // Appending in place is safe here and avoids O(n^2) array copying
          // during a provider burst; detached snapshots are never mutated.
          const pending = state.pending as Array<PendingRecord>;
          pending.push({ stream, threadSegment: resolveThreadSegment(threadId), line, bytes });
          const pendingBytes = state.pendingBytes + bytes;
          const flush =
            resolved.batchWindowMs === 0 ||
            pending.length >= resolved.maxBufferedRecords ||
            pendingBytes >= resolved.maxBufferedBytes;
          const start = flush && !state.workerRunning;
          const schedule = !flush && !state.workerRunning && !state.flushScheduled;
          return [
            { reportOverflow: false, scheduleFlush: schedule, startWorker: start },
            {
              ...state,
              pending,
              pendingBytes,
              bufferedRecords: state.bufferedRecords + 1,
              bufferedBytes: state.bufferedBytes + bytes,
              workerRunning: state.workerRunning || start,
              flushScheduled: state.flushScheduled || schedule,
            },
          ] as const;
        }).pipe(
          Effect.tap((action) =>
            action.startWorker ? startWorker : action.scheduleFlush ? scheduleFlush : Effect.void,
          ),
        ),
      );
      if (action.reportOverflow) {
        yield* logWarning("provider event log buffer is full; dropping records", {
          filePath,
          maxBufferedBytes: resolved.maxBufferedBytes,
          maxBufferedRecords: resolved.maxBufferedRecords,
        });
      }
    });

    const view = { filePath, write, close: () => Effect.void } satisfies EventNdjsonLogger;
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
  if (!store) return undefined;
  return { ...store.logger(options.stream), close: store.close };
});
