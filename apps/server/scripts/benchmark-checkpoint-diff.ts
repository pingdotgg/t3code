import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Option } from "effect";

import { parseTurnDiffFilesFromUnifiedDiff } from "../src/checkpointing/Diffs.ts";
import { CheckpointDiffQueryLive } from "../src/checkpointing/Layers/CheckpointDiffQuery.ts";
import { CheckpointStoreLive } from "../src/checkpointing/Layers/CheckpointStore.ts";
import { CheckpointDiffQuery } from "../src/checkpointing/Services/CheckpointDiffQuery.ts";
import { CheckpointStore } from "../src/checkpointing/Services/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import { ServerConfig } from "../src/config.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsDriverRegistry from "../src/vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import {
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointSummary,
} from "@t3tools/contracts";

const iterations = Number.parseInt(Bun.argv[2] ?? "20", 10);
const warmupIterations = Number.parseInt(Bun.argv[3] ?? "3", 10);
const fileCount = 24;
const baseLinesPerFile = 240;
const extraUpdatedLinesPerFile = 120;

function percentile(sortedSamples: number[], ratio: number): number {
  if (sortedSamples.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedSamples.length - 1,
    Math.max(0, Math.ceil(sortedSamples.length * ratio) - 1),
  );
  return sortedSamples[index] ?? 0;
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  return {
    iterations: samples.length,
    meanMs: Number((total / samples.length).toFixed(2)),
    minMs: Number((sorted[0] ?? 0).toFixed(2)),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
    p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
  };
}

async function benchmark(label: string, iterations: number, run: () => Promise<void>) {
  const samples: number[] = [];

  for (let index = 0; index < warmupIterations; index += 1) {
    await run();
  }

  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await run();
    samples.push(performance.now() - startedAt);
  }

  return [label, summarize(samples)] as const;
}

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function buildBaseFile(fileIndex: number): string {
  return Array.from({ length: baseLinesPerFile }, (_, lineIndex) => {
    const lineNumber = String(lineIndex).padStart(4, "0");
    return `export const file${fileIndex}Line${lineNumber} = "base-${fileIndex}-${lineNumber}";`;
  }).join("\n");
}

function buildUpdatedFile(fileIndex: number): string {
  const body = Array.from({ length: baseLinesPerFile }, (_, lineIndex) => {
    const lineNumber = String(lineIndex).padStart(4, "0");
    return [
      `  if (flag${(lineIndex % 5) + 1}) {`,
      `    lines.push("updated-${fileIndex}-${lineNumber}");`,
      "  }",
    ].join("\n");
  }).join("\n");
  const extras = Array.from({ length: extraUpdatedLinesPerFile }, (_, lineIndex) => {
    const lineNumber = String(lineIndex).padStart(4, "0");
    return `  lines.push("extra-${fileIndex}-${lineNumber}");`;
  }).join("\n");

  return [
    `export function buildFile${fileIndex}(flag1: boolean, flag2: boolean, flag3: boolean, flag4: boolean, flag5: boolean) {`,
    "  const lines: string[] = [];",
    body,
    extras,
    '  return lines.join("\\n");',
    "}",
  ].join("\n");
}

function writeWorkload(root: string, variant: "base" | "updated") {
  for (let index = 0; index < fileCount; index += 1) {
    const relativePath = path.join("src", `module-${String(index).padStart(2, "0")}.ts`);
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(
      absolutePath,
      `${variant === "base" ? buildBaseFile(index) : buildUpdatedFile(index)}\n`,
      "utf8",
    );
  }
}

async function main() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "t3-checkpoint-bench-"));
  const threadId = ThreadId.make("thread-benchmark");
  const projectId = ProjectId.make("project-benchmark");
  const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
  const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

  try {
    runGit(repoRoot, ["init"]);
    runGit(repoRoot, ["config", "user.email", "bench@test.com"]);
    runGit(repoRoot, ["config", "user.name", "Benchmark"]);
    writeWorkload(repoRoot, "base");
    runGit(repoRoot, ["add", "."]);
    runGit(repoRoot, ["commit", "-m", "initial"]);

    const checkpoints: ReadonlyArray<OrchestrationCheckpointSummary> = [
      {
        turnId: TurnId.make("turn-0"),
        checkpointTurnCount: 0,
        checkpointRef: fromCheckpointRef,
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: new Date().toISOString(),
      },
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: new Date().toISOString(),
      },
    ];

    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-benchmark-" });
    const vcsProcessLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
    const vcsDriverLayer = VcsDriverRegistry.layer.pipe(Layer.provide(vcsProcessLayer));
    const checkpointStoreLayer = CheckpointStoreLive.pipe(
      Layer.provideMerge(vcsDriverLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const projectionSnapshotLayer = Layer.mock(ProjectionSnapshotQuery)({
      getCommandReadModel: () => Effect.die("unused"),
      getSnapshot: () => Effect.die("unused"),
      getShellSnapshot: () => Effect.die("unused"),
      getSnapshotSequence: () => Effect.die("unused"),
      getCounts: () => Effect.die("unused"),
      getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
      getProjectShellById: () => Effect.die("unused"),
      getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
      getThreadShellById: () => Effect.die("unused"),
      getThreadDetailById: () => Effect.die("unused"),
      getThreadCheckpointContext: () =>
        Effect.succeed(
          Option.some({
            threadId,
            projectId,
            workspaceRoot: repoRoot,
            worktreePath: null,
            checkpoints,
          }),
        ),
    });
    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(checkpointStoreLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(vcsProcessLayer),
      Layer.provideMerge(vcsDriverLayer),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);

    try {
      const checkpointStore = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* CheckpointStore;
        }),
      );
      const checkpointDiffQuery = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* CheckpointDiffQuery;
        }),
      );
      const registry = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* VcsDriverRegistry.VcsDriverRegistry;
        }),
      );

      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd: repoRoot,
          checkpointRef: fromCheckpointRef,
        }),
      );
      writeWorkload(repoRoot, "updated");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd: repoRoot,
          checkpointRef: toCheckpointRef,
        }),
      );

      const driverHandle = await runtime.runPromise(
        registry.resolve({ cwd: repoRoot, requestedKind: "git" }),
      );
      const checkpointOps = driverHandle.driver.checkpoints;
      if (!checkpointOps) {
        throw new Error("Resolved driver does not implement checkpoints.");
      }

      const diff = await runtime.runPromise(
        checkpointStore.diffCheckpoints({
          cwd: repoRoot,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        }),
      );

      const workload = {
        changedFiles: parseTurnDiffFilesFromUnifiedDiff(diff).length,
        patchBytes: Buffer.byteLength(diff, "utf8"),
        patchLines: diff.length === 0 ? 0 : diff.split(/\r?\n/).length,
      };

      const results = Object.fromEntries(
        await Promise.all([
          benchmark("vcsRegistry.resolve", iterations, () =>
            runtime
              .runPromise(registry.resolve({ cwd: repoRoot, requestedKind: "git" }))
              .then(() => undefined),
          ),
          benchmark("driver.checkpoints.diffCheckpoints", iterations, () =>
            runtime
              .runPromise(
                checkpointOps.diffCheckpoints({
                  cwd: repoRoot,
                  fromCheckpointRef,
                  toCheckpointRef,
                  ignoreWhitespace: true,
                }),
              )
              .then(() => undefined),
          ),
          benchmark("checkpointStore.diffCheckpoints", iterations, () =>
            runtime
              .runPromise(
                checkpointStore.diffCheckpoints({
                  cwd: repoRoot,
                  fromCheckpointRef,
                  toCheckpointRef,
                  ignoreWhitespace: true,
                }),
              )
              .then(() => undefined),
          ),
          benchmark("checkpointDiffQuery.getTurnDiff", iterations, () =>
            runtime
              .runPromise(
                checkpointDiffQuery.getTurnDiff({
                  threadId,
                  fromTurnCount: 0,
                  toTurnCount: 1,
                  ignoreWhitespace: true,
                }),
              )
              .then(() => undefined),
          ),
          benchmark("parseTurnDiffFilesFromUnifiedDiff", iterations, async () => {
            parseTurnDiffFilesFromUnifiedDiff(diff);
          }),
        ]),
      );

      console.log(
        JSON.stringify(
          {
            iterations,
            warmupIterations,
            workload,
            results,
          },
          null,
          2,
        ),
      );
    } finally {
      await runtime.dispose();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

await main();
