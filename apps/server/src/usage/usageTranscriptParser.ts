// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off -- Parse workers are IPC child processes, which Effect's process API does not expose; their ready and idle deadlines live with the process callbacks.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import type { UsageProviderKind } from "@t3tools/contracts";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";

import { TRANSCRIPT_FORMAT_MAP } from "./usageTranscriptFormats.ts";
import {
  readTranscriptRecords,
  type TranscriptParsePosition,
  type TranscriptParseResult,
} from "./usageTranscriptReader.ts";

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
// Startup loads the server's entry module; a worker not ready by then is treated as failed.
const WORKER_READY_MS = 10_000;

interface TranscriptParseJob {
  readonly path: string;
  readonly provider: UsageProviderKind;
  readonly resumeFrom: TranscriptParsePosition | undefined;
}

type WorkerMessage = { readonly ready: true } | { readonly result: TranscriptParseResult | null };

interface Worker {
  readonly child: NodeChildProcess.ChildProcess;
  readonly exited: Promise<void>;
  /** Receives the in-flight job's reply, or undefined when the process stops first. */
  reply: ((result: TranscriptParseResult | null | undefined) => void) | undefined;
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
    ).then((result) => send({ result } satisfies WorkerMessage));
  });
  send({ ready: true } satisfies WorkerMessage);
}

/**
 * `readTranscriptRecords` on a pool of child processes, so a cold history uses several cores.
 * The pool fits the host's cores and available memory. Small parses, hosts that fit fewer than
 * two workers and formats a worker cannot load stay in process, as do all reads after any worker
 * failure. Closing the scope stops every worker, and reads still running end interrupted.
 */
export const makeTranscriptParser = Effect.gen(function* () {
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const environment = yield* HostProcess.Environment;
  // In a bundle import.meta.url is bin.mjs's directory; development and tests use the source.
  const entry = NodeURL.fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
  );
  // One core stays with the server. One worker parses a file at a time without the read overlap
  // in-process reads get, so a pool smaller than two cannot beat reading in process.
  const fits = Math.min(
    MAX_WORKERS,
    NodeOS.availableParallelism() - 1,
    Math.floor(process.availableMemory() / 4 / WORKER_MEMORY_BYTES),
  );
  const slots = fits >= 2 ? fits : 0;
  const permits = yield* Semaphore.make(slots);
  const live = new Set<Worker>();
  const idle: Worker[] = [];
  // Closed ends every read; failed only moves reads back in process.
  let closed = false;
  let failed = false;

  const stop = (worker: Worker): Promise<void> => {
    worker.child.kill();
    return worker.exited;
  };

  const start = (): Promise<Worker | undefined> => {
    const child = NodeChildProcess.spawn(
      executable,
      [...(isExecutable ? [] : [entry]), WORKER_COMMAND],
      {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        serialization: "advanced",
        windowsHide: true,
        env: {
          ...environment,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ""} --max-old-space-size=${WORKER_HEAP_MB}`,
        },
      },
    );
    return new Promise((resolve) => {
      let markExited = () => {};
      const worker: Worker = {
        child,
        exited: new Promise((resolveExit) => (markExited = resolveExit)),
        reply: undefined,
        idleTimer: undefined,
      };
      // Owned before the first await, so closing the scope stops a worker that is still starting.
      live.add(worker);
      const exit = () => {
        live.delete(worker);
        clearTimeout(readyTimer);
        clearTimeout(worker.idleTimer);
        const index = idle.indexOf(worker);
        if (index !== -1) idle.splice(index, 1);
        const reply = worker.reply;
        worker.reply = undefined;
        reply?.(undefined);
        resolve(undefined);
        markExited();
      };
      const readyTimer = setTimeout(() => child.kill(), WORKER_READY_MS);
      readyTimer.unref();
      child.once("exit", exit);
      // A failed spawn emits only "error".
      child.once("error", exit);
      child.on("message", (message: unknown) => {
        const reply = worker.reply;
        if (typeof message === "object" && message !== null) {
          if ("ready" in message) {
            clearTimeout(readyTimer);
            resolve(worker);
            return;
          }
          if (reply !== undefined && "result" in message) {
            worker.reply = undefined;
            reply(message.result as TranscriptParseResult | null);
            return;
          }
        }
        // Anything else is not this protocol, so no later reply can be trusted to pair.
        child.kill();
      });
    });
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

  const parse = (worker: Worker, job: TranscriptParseJob) =>
    Effect.callback<TranscriptParseResult | null | undefined>((resume) => {
      worker.reply = (result) => resume(Effect.succeed(result));
      worker.child.send(job, (error) => {
        if (error) void stop(worker);
      });
    });

  // An interrupted job stops its worker, whose late reply would otherwise answer the next job.
  const inWorker = (job: TranscriptParseJob) =>
    Effect.acquireUseRelease(
      lease,
      (worker) => (worker === undefined ? Effect.undefined : parse(worker, job)),
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
