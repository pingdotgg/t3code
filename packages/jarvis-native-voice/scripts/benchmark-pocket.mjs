// oxlint-disable t3code/no-global-process-runtime -- standalone hardware benchmark.
// Measures the production Pocket adapter: first audible PCM at the consumer,
// playout gaps, cancellation through worker close, and peak RSS. Uses the
// production worker/client and never opens an audio device.
import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeURL from "node:url";

import { bundledPocketVoicePaths, startPocketWorker } from "../src/pocket-worker-client.ts";
import { readWavFloat32Mono } from "../src/pocket-wav.ts";

const argumentsByName = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    if (separator === -1) throw new Error(`Expected --name=value, received ${argument}`);
    return [argument.slice(0, separator), argument.slice(separator + 1)];
  }),
);
for (const name of argumentsByName.keys()) {
  if (!["--warm-runs", "--resource-root", "--text"].includes(name)) {
    throw new Error(`Unknown option ${name}`);
  }
}
const warmRuns = Number(argumentsByName.get("--warm-runs") ?? "3");
if (!Number.isInteger(warmRuns) || warmRuns < 1 || warmRuns > 10) {
  throw new Error("Warm runs must be between 1 and 10.");
}
const text =
  argumentsByName.get("--text") ??
  "The task is complete. I updated the login flow and added regression tests. " +
    "All targeted checks passed. You can review the changes in the workspace.";
const paths = bundledPocketVoicePaths(argumentsByName.get("--resource-root"));
const workerPath = NodeURL.fileURLToPath(new URL("../src/pocket-worker.ts", import.meta.url));
const loopDelay = NodePerfHooks.monitorEventLoopDelay({ resolution: 10 });
const cancellation = new AbortController();
const stop = () => cancellation.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
loopDelay.enable();
console.log(
  JSON.stringify({
    event: "benchmark-config",
    engine: "pocket-2026-04",
    cpu: NodeOS.cpus()[0]?.model,
    logicalCpus: NodeOS.cpus().length,
    os: `${NodeOS.platform()} ${NodeOS.release()}`,
    node: process.version,
    warmRuns,
    measurement:
      "First audible WAV at the consumer after onset filtering; excludes audio device/player startup.",
    coldDefinition: "New Pocket process/model; OS file cache is not flushed.",
  }),
);

try {
  cancellation.signal.throwIfAborted();
  const coldStart = NodePerfHooks.performance.now();
  let worker = await startPocketWorker({
    paths,
    workerPath,
    signal: cancellation.signal,
  });
  const warmupMs = NodePerfHooks.performance.now() - coldStart;
  try {
    for (let trial = 0; trial <= warmRuns; trial += 1) {
      cancellation.signal.throwIfAborted();
      loopDelay.reset();
      const startedAt = trial === 0 ? coldStart : NodePerfHooks.performance.now();
      let firstAudibleChunkMs;
      let chunks = 0;
      let samples = 0;
      const metrics = await worker.synthesize(
        text,
        async (path, index) => {
          const wav = await readWavFloat32Mono(path);
          if (wav.samples.length === 0) throw new Error("Worker emitted an empty chunk.");
          if (wav.sampleRate !== 24_000) throw new Error("Worker emitted wrong sample rate.");
          if (index !== chunks) throw new Error("Chunk order changed.");
          chunks += 1;
          samples += wav.samples.length;
          firstAudibleChunkMs ??= NodePerfHooks.performance.now() - startedAt;
        },
        cancellation.signal,
      );
      if (chunks < 1 || firstAudibleChunkMs === undefined) {
        throw new Error("Expected audible audio for this response.");
      }
      console.log(
        JSON.stringify({
          event: "benchmark-result",
          trial,
          start: trial === 0 ? "cold" : "warm",
          warmupMs: trial === 0 ? warmupMs : 0,
          firstAudibleChunkMs,
          fullResponseReadyMs: metrics.synthesisDurationMs + (trial === 0 ? warmupMs : 0),
          requestDurationMs: NodePerfHooks.performance.now() - startedAt,
          parentEventLoopP99Ms: loopDelay.percentile(99) / 1e6,
          parentEventLoopMaxMs: loopDelay.max / 1e6,
          audioMs: (samples / 24_000) * 1000,
          ...metrics,
        }),
      );
    }
    // Cancellation through the production path: abort mid-synthesis and time
    // worker close (process teardown, playback discard, join).
    for (const triggerMs of [25, 250, 1000]) {
      const controller = new AbortController();
      const synthesis = worker
        .synthesize(
          "The connection dropped while the provider was working, so I have kept the task on its original node and will show its durable result when that node reconnects, while the other projects remain available and the selected task stays unchanged until you choose a different one.",
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
          },
          controller.signal,
        )
        .catch((cause) => cause);
      await new Promise((resolve) => setTimeout(resolve, triggerMs));
      const cancelStart = NodePerfHooks.performance.now();
      controller.abort();
      await worker.close();
      const cancelMs = NodePerfHooks.performance.now() - cancelStart;
      const outcome = await synthesis;
      console.log(
        JSON.stringify({
          event: "benchmark-cancel",
          triggerMs,
          cancelMs,
          outcome: outcome instanceof Error ? outcome.name : "resolved",
        }),
      );
      worker = await startPocketWorker({ paths, workerPath });
    }
  } finally {
    await worker.close().catch(() => undefined);
  }
} finally {
  loopDelay.disable();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
