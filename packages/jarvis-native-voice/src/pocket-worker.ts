// oxlint-disable t3code/no-global-process-runtime -- this is a dedicated native child process.
// @effect-diagnostics nodeBuiltinImport:off noFloatingEffect:off globalProcess:off globalTimers:off - this file
// is a dedicated killable native-model process, not application orchestration state.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

import {
  pocketSampleRate,
  pocketVoicePaths,
  pocketWorkerStartupTimeoutMs,
} from "./pocket-config.ts";
import { createPocketFilterPipeline } from "./pocket-pipeline.ts";
import { readWavFloat32Mono, writeWavFloat32Mono } from "./pocket-wav.ts";

type WorkerRequest = {
  readonly type: "synthesize";
  readonly requestId: string;
  readonly text: string;
  readonly outputDirectory: string;
};

type DaemonEvent =
  | { readonly type: "ready"; readonly sampleRate?: number }
  | { readonly type: "startup-failed"; readonly message: string }
  | {
      readonly type: "chunk";
      readonly requestId: string;
      readonly index: number;
      readonly path: string;
    }
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

function send(message: unknown) {
  process.send?.(message);
}

function workerRequest(value: unknown): WorkerRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<WorkerRequest>;
  return candidate.type === "synthesize" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.outputDirectory === "string"
    ? (candidate as WorkerRequest)
    : undefined;
}

function parseDaemonEvent(line: string): DaemonEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
    return value as DaemonEvent;
  } catch {
    return undefined;
  }
}

async function run() {
  const resourceRoot = process.env.JARVIS_POCKET_ROOT;
  if (resourceRoot === undefined || resourceRoot.length === 0) {
    throw new Error("Pocket resource root was not provided.");
  }
  const paths = pocketVoicePaths(resourceRoot);
  for (const file of [paths.daemonPath, paths.voiceFile, paths.bundlePath]) {
    if (!NodeFS.existsSync(file)) {
      throw new Error(`Pocket resource is missing: ${file}. Reinstall Jarvis.`);
    }
  }
  const daemon = NodeChildProcess.spawn(
    paths.daemonPath,
    ["--models", paths.modelsDir, "--voice", paths.voiceFile],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  let daemonDiagnostics = "";
  daemon.stderr?.on("data", (chunk: Buffer) => {
    daemonDiagnostics = `${daemonDiagnostics}${chunk.toString("utf8")}`.slice(-4_096);
  });
  const killDaemon = (signal: NodeJS.Signals = "SIGTERM") => {
    try {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill(signal);
    } catch {
      // Exiting anyway; the OS reaps the daemon.
    }
  };
  process.once("disconnect", () => {
    killDaemon("SIGKILL");
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    // Cancellation and lifecycle close kill this worker. Take the daemon down
    // synchronously so the parent's bounded close never waits out the timer.
    killDaemon("SIGKILL");
    process.exit(0);
  });

  const daemonLines = NodeReadline.createInterface({ input: daemon.stdout });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Pocket took too long to warm.")),
      pocketWorkerStartupTimeoutMs,
    );
    const onLine = (line: string) => {
      const event = parseDaemonEvent(line);
      if (event?.type === "ready") {
        clearTimeout(timeout);
        daemonLines.off("line", onLine);
        resolve();
      } else if (event?.type === "startup-failed") {
        clearTimeout(timeout);
        reject(new Error(event.message));
      }
    };
    daemonLines.on("line", onLine);
    daemon.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Pocket runtime exited during warmup (${signal ?? code ?? "unknown"}).`));
    });
  }).catch((cause) => {
    killDaemon("SIGKILL");
    throw cause;
  });

  daemon.once("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      send({
        type: "startup-failed",
        message:
          `Pocket speech runtime stopped (exit ${code}). ${daemonDiagnostics.trim().split(/\r?\n/u).at(-1) ?? ""}`.trim(),
      });
    } else if (signal !== null && signal !== "SIGTERM") {
      send({ type: "startup-failed", message: `Pocket speech runtime stopped (${signal}).` });
    }
  });

  send({ type: "ready" });

  // One active model means one active synthesis. The busy guard rejects
  // overlapping work instead of queueing it, so concurrent use can never
  // corrupt decoder state and destruction always happens idle. Chunk writes
  // go through the ordered pipeline, so completion always matches the
  // announced chunks.
  let active:
    | {
        readonly request: WorkerRequest;
        readonly pipeline: ReturnType<typeof createPocketFilterPipeline>;
      }
    | undefined;

  const failActive = (message: string) => {
    if (active === undefined) return;
    const requestId = active.request.requestId;
    active = undefined;
    send({ type: "failed", requestId, message });
  };

  daemonLines.on("line", (line) => {
    const event = parseDaemonEvent(line);
    if (event === undefined || active === undefined) return;
    const current = active;
    if (
      (event.type === "chunk" || event.type === "synthesis-finished" || event.type === "failed") &&
      event.requestId !== current.request.requestId
    ) {
      return;
    }
    if (event.type === "chunk") {
      current.pipeline.pushRaw(event.path);
      return;
    }
    if (event.type === "synthesis-finished") {
      current.pipeline.finish();
      return;
    }
    if (event.type === "failed") {
      failActive(event.message);
    }
  });

  process.on("message", (value) => {
    const request = workerRequest(value);
    if (request === undefined) return;
    if (active !== undefined) {
      send({
        type: "failed",
        requestId: request.requestId,
        message: "Pocket received overlapping synthesis work.",
      });
      return;
    }
    const startedAt = performance.now();
    const startedCpu = process.cpuUsage();
    const pipeline = createPocketFilterPipeline({
      requestId: request.requestId,
      outputDirectory: request.outputDirectory,
      startedAt,
      startedCpu,
      send: (pipelineEvent) => {
        if (active?.pipeline !== pipeline) return;
        if (pipelineEvent.type === "synthesis-finished") active = undefined;
        send(pipelineEvent);
      },
      fail: (message) => {
        if (active?.pipeline !== pipeline) return;
        failActive(message);
      },
      files: {
        readRaw: async (path) => readWavFloat32Mono(path),
        writeChunk: async (path, samples) => writeWavFloat32Mono(path, samples, pocketSampleRate),
      },
    });
    active = { request, pipeline };
    try {
      daemon.stdin?.write(
        `${JSON.stringify({ type: "synthesize", requestId: request.requestId, text: request.text, outputDirectory: request.outputDirectory })}\n`,
      );
    } catch (cause) {
      failActive(cause instanceof Error ? cause.message : "Pocket could not start synthesis.");
    }
  });
}

void run().catch((cause: unknown) => {
  const failure = {
    type: "startup-failed",
    message: cause instanceof Error ? cause.message : "Pocket could not start.",
  };
  if (process.send === undefined) {
    process.exit(1);
  }
  process.send(failure, () => process.exit(1));
});
