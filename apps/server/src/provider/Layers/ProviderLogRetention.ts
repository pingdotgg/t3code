import fs from "node:fs/promises";
import path from "node:path";

import { Effect, Exit, Layer, Result, Schedule } from "effect";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const INITIAL_DELAY = "15 seconds";
const SWEEP_INTERVAL = "6 hours";
const MAX_IO_CONCURRENCY = 4;
const HEAD_QUIET_PERIOD_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const LOG_TAG = "provider.log-retention";

type RemovalReason = "deletedThreads" | "unknownThreads" | "age" | "sizeCap";

export interface ProviderLogRetentionThread {
  readonly id: string;
  readonly deletedAt: string | null;
}

export interface ProviderLogSweepSummary {
  readonly scannedFiles: number;
  readonly removed: Readonly<
    Record<RemovalReason, { readonly files: number; readonly bytes: number }>
  >;
  readonly failedFiles: number;
  readonly remainingBytes: number;
}

export interface ProviderLogSweepInput {
  readonly providerLogsDir: string;
  readonly threads: ReadonlyArray<ProviderLogRetentionThread>;
  readonly liveThreadIds: ReadonlySet<string>;
  readonly retentionDays: number | null;
  readonly maxTotalMb: number | null;
  readonly nowMs?: number;
  /** Injectable only to exercise per-file filesystem failure handling. */
  readonly unlink?: (filePath: string) => Promise<void>;
}

interface LogFile {
  readonly name: string;
  readonly filePath: string;
  readonly threadSegment: string | null;
  readonly isRotation: boolean;
  readonly isSharedHead: boolean;
}

interface FileState extends LogFile {
  readonly size: number;
  readonly mtimeMs: number;
}

interface ThreadSegmentState {
  hasReadModelThread: boolean;
  allDeleted: boolean;
  hasLiveSession: boolean;
}

function emptyRemovalCounts(): Record<RemovalReason, { files: number; bytes: number }> {
  return {
    deletedThreads: { files: 0, bytes: 0 },
    unknownThreads: { files: 0, bytes: 0 },
    age: { files: 0, bytes: 0 },
    sizeCap: { files: 0, bytes: 0 },
  };
}

function classifyLogFile(name: string, directory: string): LogFile | null {
  const shared = /^(events\.log|provider-events\.ndjson|_global\.log)(?:\.(\d+))?$/.exec(name);
  if (shared) {
    const isRotation = shared[2] !== undefined;
    return {
      name,
      filePath: path.join(directory, name),
      threadSegment: null,
      isRotation,
      isSharedHead: !isRotation,
    };
  }

  const match = /^(.*)\.log(?:\.(\d+))?$/.exec(name);
  if (!match || !match[1]) return null;
  const isRotation = match[2] !== undefined;
  return {
    name,
    filePath: path.join(directory, name),
    threadSegment: match[1],
    isRotation,
    isSharedHead: false,
  };
}

async function forEachConcurrent<T>(
  values: ReadonlyArray<T>,
  f: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_IO_CONCURRENCY, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        await f(values[index]!);
      }
    }),
  );
}

function buildThreadSegmentStates(
  threads: ReadonlyArray<ProviderLogRetentionThread>,
  liveThreadIds: ReadonlySet<string>,
): Map<string, ThreadSegmentState> {
  const states = new Map<string, ThreadSegmentState>();
  const stateFor = (threadId: string): ThreadSegmentState | null => {
    const segment = toSafeThreadAttachmentSegment(threadId);
    if (!segment) return null;
    let state = states.get(segment);
    if (!state) {
      state = { hasReadModelThread: false, allDeleted: true, hasLiveSession: false };
      states.set(segment, state);
    }
    return state;
  };

  for (const thread of threads) {
    const state = stateFor(thread.id);
    if (!state) continue;
    state.hasReadModelThread = true;
    if (thread.deletedAt === null) state.allDeleted = false;
  }
  for (const threadId of liveThreadIds) {
    const state = stateFor(threadId);
    if (state) state.hasLiveSession = true;
  }
  return states;
}

function isProtectedHead(
  file: FileState,
  nowMs: number,
  segments: Map<string, ThreadSegmentState>,
) {
  if (file.isSharedHead) return true;
  return (
    !file.isRotation &&
    (file.mtimeMs > nowMs - HEAD_QUIET_PERIOD_MS ||
      segments.get(file.threadSegment ?? "")?.hasLiveSession === true)
  );
}

function getValidRetentionDays(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function getValidSizeCapBytes(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value * MB : null;
}

/**
 * Sweep recognized provider log files. The read model and session list are
 * snapshots taken by the caller; all filesystem work stays outside orchestration.
 */
export async function sweepProviderLogs(
  input: ProviderLogSweepInput,
): Promise<ProviderLogSweepSummary> {
  const removed = emptyRemovalCounts();
  let failedFiles = 0;
  let scannedFiles = 0;
  const remaining = new Map<string, FileState>();
  const nowMs = input.nowMs ?? Date.now();
  const retentionDays = getValidRetentionDays(input.retentionDays);
  const retentionCutoff = retentionDays === null ? null : nowMs - retentionDays * DAY_MS;
  const sizeCapBytes = getValidSizeCapBytes(input.maxTotalMb);
  const segments = buildThreadSegmentStates(input.threads, input.liveThreadIds);
  const unlink = input.unlink ?? ((filePath: string) => fs.unlink(filePath));
  let sizePassTotalBytes: number | null = null;

  let entries;
  try {
    entries = await fs.readdir(input.providerLogsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { scannedFiles, removed, failedFiles, remainingBytes: 0 };
    }
    return { scannedFiles, removed, failedFiles: 1, remainingBytes: 0 };
  }

  const candidates = entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const file = classifyLogFile(entry.name, input.providerLogsDir);
    return file ? [file] : [];
  });

  await forEachConcurrent(candidates, async (candidate) => {
    try {
      const stat = await fs.stat(candidate.filePath);
      if (!stat.isFile()) return;
      remaining.set(candidate.filePath, { ...candidate, size: stat.size, mtimeMs: stat.mtimeMs });
      scannedFiles += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failedFiles += 1;
    }
  });

  const failedPaths = new Set<string>();
  const remove = async (file: FileState, reason: RemovalReason): Promise<void> => {
    if (failedPaths.has(file.filePath) || isProtectedHead(file, nowMs, segments)) return;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(file.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const previousSize = remaining.get(file.filePath)?.size ?? file.size;
        remaining.delete(file.filePath);
        if (sizePassTotalBytes !== null) sizePassTotalBytes -= previousSize;
      } else {
        failedFiles += 1;
        failedPaths.add(file.filePath);
      }
      return;
    }
    const previousSize = remaining.get(file.filePath)?.size ?? file.size;
    if (!stat.isFile()) {
      remaining.delete(file.filePath);
      if (sizePassTotalBytes !== null) sizePassTotalBytes -= previousSize;
      return;
    }

    const fresh = { ...file, size: stat.size, mtimeMs: stat.mtimeMs };
    if (sizePassTotalBytes !== null) sizePassTotalBytes += stat.size - previousSize;
    remaining.set(file.filePath, fresh);
    if (isProtectedHead(fresh, nowMs, segments)) return;
    if (reason === "age" && (retentionCutoff === null || stat.mtimeMs >= retentionCutoff)) return;
    try {
      await unlink(file.filePath);
      remaining.delete(file.filePath);
      if (sizePassTotalBytes !== null) sizePassTotalBytes -= stat.size;
      removed[reason].files += 1;
      removed[reason].bytes += stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        failedFiles += 1;
        failedPaths.add(file.filePath);
      } else {
        const currentSize = remaining.get(file.filePath)?.size ?? stat.size;
        remaining.delete(file.filePath);
        if (sizePassTotalBytes !== null) sizePassTotalBytes -= currentSize;
      }
    }
  };

  const threadFiles = [...remaining.values()].filter((file) => file.threadSegment !== null);
  const deletedThreads = threadFiles.filter(
    (file) => segments.get(file.threadSegment!)?.allDeleted === true,
  );
  const unknownThreads = threadFiles.filter((file) => !segments.has(file.threadSegment!));
  await forEachConcurrent(deletedThreads, (file) => remove(file, "deletedThreads"));
  await forEachConcurrent(unknownThreads, (file) => remove(file, "unknownThreads"));

  if (retentionCutoff !== null) {
    const oldFiles = [...remaining.values()].filter(
      (file) => file.mtimeMs < retentionCutoff && !isProtectedHead(file, nowMs, segments),
    );
    await forEachConcurrent(oldFiles, (file) => remove(file, "age"));
  }

  if (sizeCapBytes !== null) {
    await forEachConcurrent([...remaining.values()], async (file) => {
      try {
        const stat = await fs.stat(file.filePath);
        if (!stat.isFile()) {
          remaining.delete(file.filePath);
          return;
        }
        remaining.set(file.filePath, { ...file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          remaining.delete(file.filePath);
        } else {
          failedFiles += 1;
          failedPaths.add(file.filePath);
        }
      }
    });
    sizePassTotalBytes = [...remaining.values()].reduce((total, file) => total + file.size, 0);
    const sizeCandidates = [...remaining.values()].filter(
      (file) => !isProtectedHead(file, nowMs, segments),
    );
    sizeCandidates.sort(
      (left, right) =>
        Number(left.isRotation === false) - Number(right.isRotation === false) ||
        left.mtimeMs - right.mtimeMs ||
        left.name.localeCompare(right.name),
    );
    for (const file of sizeCandidates) {
      if (sizePassTotalBytes <= sizeCapBytes) break;
      await remove(file, "sizeCap");
    }
  }

  return {
    scannedFiles,
    removed,
    failedFiles,
    remainingBytes: [...remaining.values()].reduce((total, file) => total + file.size, 0),
  };
}

function logSweepSummary(
  providerLogsDir: string,
  summary: ProviderLogSweepSummary,
  failure?: unknown,
): Effect.Effect<void> {
  return Effect.logInfo(`${LOG_TAG}: sweep complete`, {
    providerLogsDir,
    scannedFiles: summary.scannedFiles,
    removed: summary.removed,
    removedFiles: Object.values(summary.removed).reduce((total, reason) => total + reason.files, 0),
    removedBytes: Object.values(summary.removed).reduce((total, reason) => total + reason.bytes, 0),
    failedFiles: summary.failedFiles,
    remainingBytes: summary.remainingBytes,
    ...(failure === undefined ? {} : { failure }),
  });
}

const sweepOnce = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const engine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const settings = yield* Effect.result(settingsService.getSettings);
  if (Result.isFailure(settings)) {
    yield* logSweepSummary(
      config.providerLogsDir,
      {
        scannedFiles: 0,
        removed: emptyRemovalCounts(),
        failedFiles: 0,
        remainingBytes: 0,
      },
      "settings-unavailable",
    );
    return;
  }

  const readModelExit = yield* Effect.exit(engine.getReadModel());
  const sessionsExit = yield* Effect.exit(providerService.listSessions());
  if (Exit.isFailure(readModelExit) || Exit.isFailure(sessionsExit)) {
    yield* logSweepSummary(
      config.providerLogsDir,
      {
        scannedFiles: 0,
        removed: emptyRemovalCounts(),
        failedFiles: 0,
        remainingBytes: 0,
      },
      "runtime-state-unavailable",
    );
    return;
  }

  const sweepResult = yield* Effect.result(
    Effect.tryPromise({
      try: () =>
        sweepProviderLogs({
          providerLogsDir: config.providerLogsDir,
          threads: readModelExit.value.threads.map((thread) => ({
            id: thread.id,
            deletedAt: thread.deletedAt,
          })),
          liveThreadIds: new Set(sessionsExit.value.map((session) => session.threadId)),
          retentionDays: settings.success.providerLogRetentionDays,
          maxTotalMb: settings.success.providerLogMaxTotalMb,
        }),
      catch: () => new Error("provider log retention sweep failed"),
    }),
  );
  if (Result.isFailure(sweepResult)) {
    yield* logSweepSummary(
      config.providerLogsDir,
      {
        scannedFiles: 0,
        removed: emptyRemovalCounts(),
        failedFiles: 1,
        remainingBytes: 0,
      },
      "sweep-failed",
    );
    return;
  }
  yield* logSweepSummary(config.providerLogsDir, sweepResult.success);
});

const makeReactor = Effect.gen(function* () {
  yield* Effect.forkScoped(
    Effect.sleep(INITIAL_DELAY).pipe(
      Effect.andThen(sweepOnce.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)))),
    ),
  );
});

export const layer = Layer.effectDiscard(makeReactor);
