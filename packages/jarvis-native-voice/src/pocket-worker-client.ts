// oxlint-disable t3code/no-global-process-runtime -- this file owns the disposable native worker.
// @effect-diagnostics nodeBuiltinImport:off globalProcess:off globalTimers:off - the desktop voice worker
// isolates Pocket in a disposable child process so model memory is returned to the OS.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import * as NodeTimersPromises from "node:timers/promises";

import {
  bundledPocketVoicePaths,
  pocketResourceError,
  pocketVoicePaths,
  pocketWorkerCloseTimeoutMs,
  pocketWorkerStartupTimeoutMs,
  type PocketVoicePaths,
} from "./pocket-config.ts";
import type {
  PocketChunkConsumer,
  PocketSynthesisMetrics,
  PocketWorker,
} from "./pocket-lifecycle.ts";

export type { PocketVoicePaths };
export { bundledPocketVoicePaths, pocketResourceError, pocketVoicePaths };

type PendingSynthesis = {
  readonly requestId: string;
  readonly resolve: (metrics: PocketSynthesisMetrics) => void;
  readonly reject: (cause: Error) => void;
  readonly outputDirectory: string;
  readonly consumeChunk: PocketChunkConsumer;
  serial: Promise<void>;
  finished?: PocketSynthesisMetrics;
  failure?: Error;
  settled: boolean;
};

type WorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "startup-failed"; readonly message: string }
  | { readonly type: "chunk"; readonly requestId: string; readonly index: number }
  | {
      readonly type: "synthesis-finished";
      readonly requestId: string;
      readonly chunkCount: number;
      readonly totalSamples: number;
      readonly sampleRate: number;
      readonly synthesisDurationMs: number;
      readonly synthesisCpuMs: number;
      readonly peakRssBytes: number;
      readonly firstChunkReadyMs?: number;
    }
  | { readonly type: "failed"; readonly requestId: string; readonly message: string };

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  isNonNegativeFinite(value) && Number.isInteger(value);

function parseWorkerMessage(value: unknown): WorkerMessage | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  const candidate = value as Partial<WorkerMessage>;
  if (candidate.type === "ready") return { type: "ready" };
  if (candidate.type === "startup-failed" && typeof candidate.message === "string") {
    return { type: candidate.type, message: candidate.message };
  }
  if (candidate.type === "chunk" && typeof candidate.requestId === "string") {
    const chunk = value as Partial<Extract<WorkerMessage, { readonly type: "chunk" }>>;
    return isNonNegativeInteger(chunk.index)
      ? { type: candidate.type, requestId: candidate.requestId, index: chunk.index }
      : undefined;
  }
  if (candidate.type === "synthesis-finished" && typeof candidate.requestId === "string") {
    const finished = value as Partial<
      Extract<WorkerMessage, { readonly type: "synthesis-finished" }>
    >;
    if (
      !isNonNegativeInteger(finished.chunkCount) ||
      !isNonNegativeInteger(finished.totalSamples) ||
      !isNonNegativeFinite(finished.sampleRate) ||
      finished.sampleRate === 0 ||
      !isNonNegativeFinite(finished.synthesisDurationMs) ||
      !isNonNegativeFinite(finished.synthesisCpuMs) ||
      !isNonNegativeFinite(finished.peakRssBytes) ||
      (finished.firstChunkReadyMs !== undefined && !isNonNegativeFinite(finished.firstChunkReadyMs))
    ) {
      return undefined;
    }
    return {
      type: candidate.type,
      requestId: candidate.requestId,
      chunkCount: finished.chunkCount,
      totalSamples: finished.totalSamples,
      sampleRate: finished.sampleRate,
      synthesisDurationMs: finished.synthesisDurationMs,
      synthesisCpuMs: finished.synthesisCpuMs,
      peakRssBytes: finished.peakRssBytes,
      ...(finished.firstChunkReadyMs !== undefined
        ? { firstChunkReadyMs: finished.firstChunkReadyMs }
        : {}),
    };
  }
  if (candidate.type === "failed" && typeof candidate.requestId === "string") {
    const failed = value as Partial<Extract<WorkerMessage, { readonly type: "failed" }>>;
    return typeof failed.message === "string"
      ? { type: candidate.type, requestId: candidate.requestId, message: failed.message }
      : undefined;
  }
  return undefined;
}

export async function startPocketWorker(
  input: {
    readonly paths?: PocketVoicePaths;
    readonly workerPath?: string;
    readonly spawnWorker?: typeof NodeChildProcess.fork;
    readonly startupTimeoutMs?: number;
    readonly closeTimeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<PocketWorker> {
  const paths = input.paths ?? bundledPocketVoicePaths();
  const resourceError = pocketResourceError(paths);
  if (resourceError !== undefined) throw resourceError;
  const spawnWorker = input.spawnWorker ?? NodeChildProcess.fork;
  const child: NodeChildProcess.ChildProcess = spawnWorker(
    input.workerPath ?? NodePath.join(import.meta.dirname, "pocket-worker.cjs"),
    [],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        JARVIS_POCKET_ROOT: paths.resourceRoot,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-4_096);
  });
  let closed = false;
  const pending = new Map<string, PendingSynthesis>();
  const activeOperations = new Set<Promise<unknown>>();
  const closeTimeoutMs = input.closeTimeoutMs ?? pocketWorkerCloseTimeoutMs;
  let closePromise: Promise<void> | undefined;
  const closeChild = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = new Promise<void>((resolveClose) => {
      let settled = false;
      let forceTimeout: NodeJS.Timeout | undefined;
      let abandonTimeout: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (forceTimeout !== undefined) NodeTimers.clearTimeout(forceTimeout);
        if (abandonTimeout !== undefined) NodeTimers.clearTimeout(abandonTimeout);
        child.removeListener("close", finish);
        child.removeListener("exit", finish);
        child.removeListener("error", finish);
        resolveClose();
      };
      child.once("close", finish);
      child.once("exit", finish);
      child.once("error", finish);
      forceTimeout = NodeTimers.setTimeout(() => {
        child.kill("SIGKILL");
        abandonTimeout = NodeTimers.setTimeout(finish, closeTimeoutMs);
      }, closeTimeoutMs);
      if (child.exitCode !== null || child.signalCode !== null) finish();
      else if (!child.killed) child.kill("SIGTERM");
    });
    return closePromise;
  };
  const finishRequest = async (requestId: string, request: PendingSynthesis): Promise<void> => {
    if (request.settled) return;
    if (request.finished === undefined && request.failure === undefined) return;
    request.settled = true;
    pending.delete(requestId);
    await request.serial;
    if (request.failure !== undefined) request.reject(request.failure);
    else if (request.finished !== undefined) request.resolve(request.finished);
  };
  const failRequest = (request: PendingSynthesis, cause: unknown) => {
    if (request.failure === undefined) {
      request.failure = cause instanceof Error ? cause : new Error("Pocket synthesis failed.");
    }
    void closeChild();
    void finishRequest(request.requestId, request);
  };
  const rejectPending = (cause: Error) => {
    for (const request of pending.values()) failRequest(request, cause);
  };
  const abortStartup = () => {
    void closeChild();
  };
  input.signal?.addEventListener("abort", abortStartup, { once: true });
  if (input.signal?.aborted) abortStartup();

  await new Promise<void>((resolveReady, rejectReady) => {
    let settled = false;
    const timeout = new AbortController();
    const finish = (cause?: Error) => {
      if (settled) return;
      settled = true;
      timeout.abort();
      input.signal?.removeEventListener("abort", abortStartup);
      if (cause === undefined) resolveReady();
      else rejectReady(cause);
    };
    void NodeTimersPromises.setTimeout(
      input.startupTimeoutMs ?? pocketWorkerStartupTimeoutMs,
      undefined,
      {
        signal: timeout.signal,
      },
    )
      .then(() => finish(new Error("Pocket took too long to warm.")))
      .catch(() => undefined);
    child.once("error", (cause) => finish(cause));
    child.once("close", (code, signal) => {
      const detail = diagnostics.trim().split(/\r?\n/u).at(-1);
      finish(
        new Error(
          detail ??
            `Pocket stopped while warming${signal === null ? ` (exit ${code ?? "unknown"})` : ` (${signal})`}.`,
        ),
      );
    });
    child.on("message", (value) => {
      const message = parseWorkerMessage(value);
      if (message?.type === "ready") finish();
      if (message?.type === "startup-failed") finish(new Error(message.message));
    });
  }).catch(async (cause) => {
    await closeChild();
    throw cause;
  });

  child.on("message", (value) => {
    const message = parseWorkerMessage(value);
    if (
      message?.type !== "chunk" &&
      message?.type !== "synthesis-finished" &&
      message?.type !== "failed"
    )
      return;
    const request = pending.get(message.requestId);
    if (request === undefined) return;
    if (message.type === "chunk") {
      const path = NodePath.join(
        request.outputDirectory,
        `chunk-${String(message.index).padStart(6, "0")}.wav`,
      );
      request.serial = request.serial
        .then(() => request.consumeChunk(path, message.index))
        .catch((cause) => {
          failRequest(request, cause);
        });
      return;
    }
    if (message.type === "synthesis-finished") {
      request.finished = {
        chunkCount: message.chunkCount,
        totalSamples: message.totalSamples,
        sampleRate: message.sampleRate,
        synthesisDurationMs: message.synthesisDurationMs,
        synthesisCpuMs: message.synthesisCpuMs,
        peakRssBytes: message.peakRssBytes,
        ...(message.firstChunkReadyMs === undefined
          ? {}
          : { firstChunkReadyMs: message.firstChunkReadyMs }),
      };
      void finishRequest(message.requestId, request);
    } else {
      failRequest(request, new Error(message.message));
      void finishRequest(message.requestId, request);
    }
  });
  child.once("close", () => {
    closed = true;
    rejectPending(new Error("Pocket stopped before speech was ready."));
  });

  return {
    async synthesize(text, consumeChunk, signal) {
      if (closed || child.connected !== true) {
        return Promise.reject(new Error("Pocket is not ready."));
      }
      if (signal?.aborted) {
        return Promise.reject(new DOMException("Jarvis speech was interrupted.", "AbortError"));
      }
      const operation = (async () => {
        const requestId = NodeCrypto.randomUUID();
        const outputDirectory = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "jarvis-pocket-"),
        );
        let removeAbort: () => void = () => undefined;
        try {
          return await new Promise<PocketSynthesisMetrics>((resolveSynthesis, rejectSynthesis) => {
            const request: PendingSynthesis = {
              requestId,
              resolve: resolveSynthesis,
              reject: rejectSynthesis,
              outputDirectory,
              consumeChunk,
              serial: Promise.resolve(),
              settled: false,
            };
            pending.set(requestId, request);
            const onAbort = () => {
              failRequest(
                request,
                new DOMException("Jarvis speech was interrupted.", "AbortError"),
              );
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            removeAbort = () => signal?.removeEventListener("abort", onAbort);
            child.send({ type: "synthesize", requestId, text, outputDirectory }, (cause) => {
              if (cause === null || cause === undefined) return;
              failRequest(request, cause);
            });
          });
        } finally {
          removeAbort();
          await NodeFSP.rm(outputDirectory, { recursive: true, force: true });
        }
      })();
      activeOperations.add(operation);
      try {
        return await operation;
      } finally {
        activeOperations.delete(operation);
      }
    },
    async close() {
      if (!closed) {
        closed = true;
        rejectPending(new DOMException("Jarvis speech was interrupted.", "AbortError"));
      }
      await closeChild();
      await Promise.allSettled(activeOperations);
    },
  };
}
