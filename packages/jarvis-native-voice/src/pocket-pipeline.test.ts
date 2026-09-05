// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - deterministic IPC fake with explicit timers.
// Regression test for ordered Pocket chunk completion. A long response used
// to report synthesis-finished before its slowest chunk writes landed, so
// filtered WAV files arrived after the parent removed the request directory.
import { assert, describe, it } from "@effect/vitest";

import { createPocketFilterPipeline, type PocketPipelineEvent } from "./pocket-pipeline.ts";

const loud = (count: number): Float32Array => {
  const samples = new Float32Array(count);
  samples.fill(0.2);
  return samples;
};

describe("Pocket filter pipeline", () => {
  it("announces chunks in daemon order and finishes last with the exact count", async () => {
    const events: Array<PocketPipelineEvent> = [];
    const failures: Array<string> = [];
    const releaseRaw: Array<() => void> = [];
    const written: Array<string> = [];
    const pipeline = createPocketFilterPipeline({
      requestId: "request-1",
      outputDirectory: "/tmp/jarvis-pocket-test",
      startedAt: performance.now(),
      startedCpu: process.cpuUsage(),
      send: (event) => events.push(event),
      fail: (message) => failures.push(message),
      files: {
        readRaw: (_path) =>
          new Promise<{ readonly samples: Float32Array }>((resolve) => {
            // First chunk reads slowest; completion must still wait for it.
            releaseRaw.push(() => resolve({ samples: loud(240) }));
          }),
        writeChunk: async (path) => {
          written.push(path);
        },
      },
    });
    pipeline.pushRaw("/tmp/raw-000000.wav");
    pipeline.pushRaw("/tmp/raw-000001.wav");
    pipeline.pushRaw("/tmp/raw-000002.wav");
    pipeline.finish();
    assert.deepEqual(events, []);
    // The chain reads strictly in order: only the first read is pending, so
    // releasing index 1 and 2 now is a no-op and nothing may complete.
    releaseRaw[1]?.();
    releaseRaw[2]?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, []);
    // Drain every pending read in order until the pipeline completes.
    for (let round = 0; round < 10 && events.at(-1)?.type !== "synthesis-finished"; round += 1) {
      while (releaseRaw.length > 0) releaseRaw.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const indices = events.filter((event) => event.type === "chunk").map((event) => event.index);
    assert.deepEqual(indices, [0, 1, 2]);
    const finished = events.find((event) => event.type === "synthesis-finished");
    assert.equal(finished?.type, "synthesis-finished");
    if (finished?.type !== "synthesis-finished") throw new Error("Expected synthesis-finished.");
    assert.equal(finished.chunkCount, 3);
    assert.equal(events.at(-1)?.type, "synthesis-finished");
    assert.deepEqual(failures, []);
    assert.deepEqual(written, [
      "/tmp/jarvis-pocket-test/chunk-000000.wav",
      "/tmp/jarvis-pocket-test/chunk-000001.wav",
      "/tmp/jarvis-pocket-test/chunk-000002.wav",
    ]);
  });

  it("reports file failures instead of completing successfully", async () => {
    const events: Array<PocketPipelineEvent> = [];
    const failures: Array<string> = [];
    const pipeline = createPocketFilterPipeline({
      requestId: "request-2",
      outputDirectory: "/tmp/jarvis-pocket-test",
      startedAt: performance.now(),
      startedCpu: process.cpuUsage(),
      send: (event) => events.push(event),
      fail: (message) => failures.push(message),
      files: {
        readRaw: async () => {
          throw new Error("Disk went away.");
        },
        writeChunk: async () => undefined,
      },
    });
    pipeline.pushRaw("/tmp/raw-000000.wav");
    pipeline.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(failures, ["Disk went away."]);
    assert.deepEqual(events, []);
  });
});
