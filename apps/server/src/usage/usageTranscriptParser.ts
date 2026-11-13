// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off -- Parse workers are IPC child processes, which Effect's process API does not expose; their ready and idle deadlines live with the process callbacks.
import * as NodeOS from "node:os";

import type { UsageProviderKind } from "@t3tools/contracts";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";

import { serverSubcommand } from "../cli/serverSubcommand.ts";
import {
  makeUsageTranscriptWorker,
  type TranscriptParseJob,
  type TranscriptWorkerMessage,
  type UsageTranscriptWorker,
} from "./usageTranscriptWorker.ts";
import { TRANSCRIPT_FORMAT_MAP } from "./usageTranscriptFormats.ts";
import { readTranscriptRecords, type TranscriptParsePosition } from "./usageTranscriptReader.ts";

const WORKER_COMMAND = "__usage-transcript-worker";
// Below this a parse costs well under a millisecond in process: tiny appends never start a worker,
// and files this small hold about 1% of a cold history's bytes.
const INLINE_PARSE_BYTES = 256 * 1024;
// More workers measured no faster on a cold history; they only add memory.
const MAX_WORKERS = 7;
// A parsing worker peaks near 300 MiB resident; the pool may claim a quarter of available memory.
const WORKER_MEMORY_BYTES = 320 * 1024 * 1024;
// Only stops a runaway parse. Below 2 GiB V8 grows the heap so cautiously that a cold history
// parses about a quarter slower, at the same resident memory.
const WORKER_HEAP_MB = 2048;
// Reads the service overlaps when parsing in process, so file I/O hides behind parsing.
const IN_PROCESS_READS = 4;
const WORKER_IDLE_MS = 30_000;

export const TranscriptParserCapacity = Context.Reference<{
  readonly cores: number;
  readonly availableMemory: number;
}>("t3/usage/TranscriptParserCapacity", {
  defaultValue: () => ({
    cores: NodeOS.availableParallelism(),
    availableMemory: process.availableMemory(),
  }),
});

interface Worker {
  readonly process: UsageTranscriptWorker;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Runs in a `__usage-transcript-worker` child: parses one transcript per message with the
 * same reader and formats the server uses, until the server disconnects.
 */
export function runUsageTranscriptWorker(): void {
  const send = process.send?.bind(process);
  if (send === undefined) throw new Error("The usage transcript worker needs an IPC channel.");
  process.on("disconnect", () => process.exit(0));
  process.on("message", (job: TranscriptParseJob) => {
    const format = TRANSCRIPT_FORMAT_MAP.get(job.provider);
    void (
      format === undefined
        ? Promise.resolve(null)
        : readTranscriptRecords(job.path, format, job.resumeFrom)
    ).then((result) => send({ result } satisfies TranscriptWorkerMessage));
  });
  send({ ready: true } satisfies TranscriptWorkerMessage);
}

/**
 * `readTranscriptRecords` on a pool of child processes, so a cold history uses several cores.
 * The pool fits the host's cores and available memory. Small parses, hosts that fit fewer than
 * two workers and formats a worker cannot load stay in process, as do all reads after any worker
 * failure. Closing the scope stops every worker, and reads still running end interrupted.
 */
export const makeTranscriptParser = Effect.gen(function* () {
  const command = yield* serverSubcommand(WORKER_COMMAND, WORKER_HEAP_MB);
  // One core stays with the server. One worker parses a file at a time without the read overlap
  // in-process reads get, so a pool smaller than two cannot beat reading in process.
  const capacity = yield* TranscriptParserCapacity;
  const fits = Math.min(
    MAX_WORKERS,
    capacity.cores - 1,
    Math.floor(capacity.availableMemory / 4 / WORKER_MEMORY_BYTES),
  );
  const slots = fits >= 2 ? fits : 0;
  const permits = yield* Semaphore.make(slots);
  const live = new Set<Worker>();
  const idle: Worker[] = [];
  // Closed ends every read; failed only moves reads back in process.
  let closed = false;
  let failed = false;

  const stop = (worker: Worker) => worker.process.stop();

  const start = async (): Promise<Worker | undefined> => {
    const process = makeUsageTranscriptWorker(command);
    const worker: Worker = { process, idleTimer: undefined };
    live.add(worker);
    void process.exited.then(() => {
      live.delete(worker);
      clearTimeout(worker.idleTimer);
      const index = idle.indexOf(worker);
      if (index !== -1) idle.splice(index, 1);
    });
    return (await process.ready) ? worker : undefined;
  };

  const lease = Effect.promise(async () => {
    if (closed || failed) return undefined;
    const worker = idle.pop();
    if (worker === undefined) return start();
    clearTimeout(worker.idleTimer);
    return worker;
  });

  const release = (worker: Worker | undefined, healthy: boolean) =>
    Effect.promise(async () => {
      if (worker === undefined) return;
      if (!healthy || closed || failed || !live.has(worker)) return stop(worker);
      idle.push(worker);
      worker.idleTimer = setTimeout(() => {
        const index = idle.indexOf(worker);
        if (index === -1) return;
        idle.splice(index, 1);
        void stop(worker);
      }, WORKER_IDLE_MS);
      worker.idleTimer.unref();
    });

  // An interrupted job stops its worker, whose late reply would otherwise answer the next job.
  const inWorker = (job: TranscriptParseJob) =>
    Effect.acquireUseRelease(
      lease,
      (worker) => (worker === undefined ? Effect.undefined : worker.process.parse(job)),
      (worker, exit) => release(worker, Exit.isSuccess(exit) && exit.value !== undefined),
    ).pipe(permits.withPermit);

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closed = true;
      await Promise.all([...live].map(stop));
    }),
  );

  // Untraced like the per-file reads that call it: a cold scan parses thousands of files.
  const read = Effect.fnUntraced(function* (input: {
    readonly path: string;
    readonly size: number;
    readonly provider: UsageProviderKind;
    readonly format: TranscriptUsageFormat<unknown>;
    readonly resumeFrom: TranscriptParsePosition | undefined;
  }) {
    const { path, size: fileSize, provider, format, resumeFrom } = input;
    if (closed) return yield* Effect.interrupt;
    const inProcess = Effect.promise((signal) =>
      readTranscriptRecords(path, format, resumeFrom, { signal }),
    );
    if (
      failed ||
      slots === 0 ||
      fileSize - (resumeFrom?.resumeOffset ?? 0) < INLINE_PARSE_BYTES ||
      TRANSCRIPT_FORMAT_MAP.get(provider) !== format
    ) {
      return yield* inProcess;
    }
    const parsed = yield* inWorker({ path, provider, resumeFrom });
    if (parsed !== undefined) return parsed;
    if (closed) return yield* Effect.interrupt;
    // A worker that stopped mid-job loses only that job; it is read again in process.
    if (!failed) {
      failed = true;
      yield* Effect.logWarning("Usage transcript workers stopped; parsing transcripts in process.");
      yield* Effect.promise(() => Promise.all(idle.splice(0).map(stop)));
    }
    return yield* inProcess;
  });

  /** How many reads keep the parser busy: one per worker, or overlapping reads in process. */
  return { read, concurrency: Math.max(slots, IN_PROCESS_READS) } as const;
});
