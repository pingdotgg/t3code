// @effect-diagnostics nodeBuiltinImport:off - chunk paths mirror the packaged native exchange.
// Ordered Pocket chunk pipeline. Raw daemon chunks are filtered for leading
// silence and announced strictly in daemon order: each write completes before
// the next begins, and completion waits for every pending write. The reported
// count always matches the announced chunks, so no file lands after the
// parent removes the request directory.
import * as NodePath from "node:path";

import { createPocketOnsetFilter, type PocketOnsetFilter } from "./pocket-onset.ts";
import { pocketSampleRate } from "./pocket-config.ts";

export type PocketPipelineEvent =
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
    };

export type PocketPipelineFileIO = {
  readonly readRaw: (path: string) => Promise<{ readonly samples: Float32Array }>;
  readonly writeChunk: (path: string, samples: Float32Array) => Promise<void>;
};

export function createPocketFilterPipeline(input: {
  readonly requestId: string;
  readonly outputDirectory: string;
  readonly startedAt: number;
  readonly startedCpu: NodeJS.CpuUsage;
  readonly send: (event: PocketPipelineEvent) => void;
  readonly fail: (message: string) => void;
  readonly files: PocketPipelineFileIO;
  readonly filter?: PocketOnsetFilter;
}): {
  readonly pushRaw: (path: string) => void;
  readonly finish: () => void;
} {
  const filter = input.filter ?? createPocketOnsetFilter();
  let chain: Promise<void> = Promise.resolve();
  let done = false;
  let filteredIndex = 0;
  let filteredSamples = 0;
  let firstChunkAt: number | undefined;

  const chunkPath = (index: number): string =>
    NodePath.join(input.outputDirectory, `chunk-${String(index).padStart(6, "0")}.wav`);

  const pushRaw = (path: string): void => {
    chain = chain
      .then(async () => {
        if (done) return;
        const raw = await input.files.readRaw(path);
        const filtered = filter.push(raw.samples);
        if (filtered === undefined || filtered.length === 0) return;
        if (firstChunkAt === undefined) firstChunkAt = performance.now();
        const index = filteredIndex;
        filteredIndex += 1;
        filteredSamples += filtered.length;
        await input.files.writeChunk(chunkPath(index), filtered);
        input.send({ type: "chunk", requestId: input.requestId, index });
      })
      .catch((cause: unknown) => {
        done = true;
        input.fail(cause instanceof Error ? cause.message : "Pocket chunk failed.");
      });
  };

  const finish = (): void => {
    chain = chain
      .then(async () => {
        if (done) return;
        done = true;
        const tail = filter.finish();
        if (tail.length > 0) {
          if (firstChunkAt === undefined) firstChunkAt = performance.now();
          const index = filteredIndex;
          filteredIndex += 1;
          filteredSamples += tail.length;
          await input.files.writeChunk(chunkPath(index), tail);
          input.send({ type: "chunk", requestId: input.requestId, index });
        }
        const cpu = process.cpuUsage(input.startedCpu);
        input.send({
          type: "synthesis-finished",
          requestId: input.requestId,
          chunkCount: filteredIndex,
          totalSamples: filteredSamples,
          sampleRate: pocketSampleRate,
          synthesisDurationMs: performance.now() - input.startedAt,
          synthesisCpuMs: (cpu.user + cpu.system) / 1_000,
          peakRssBytes: process.resourceUsage().maxRSS * 1_024,
          ...(firstChunkAt === undefined
            ? {}
            : { firstChunkReadyMs: firstChunkAt - input.startedAt }),
        });
      })
      .catch((cause: unknown) => {
        done = true;
        input.fail(cause instanceof Error ? cause.message : "Pocket finish failed.");
      });
  };

  return { pushRaw, finish };
}
