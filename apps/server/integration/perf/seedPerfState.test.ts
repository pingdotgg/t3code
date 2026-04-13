import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PERF_CATALOG_IDS, getPerfSeedScenario } from "@t3tools/shared/perf/scenarioCatalog";
import { seedPerfState } from "./seedPerfState.ts";

describe("seedPerfState", () => {
  const runParentDirsToCleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      runParentDirsToCleanup
        .splice(0)
        .map((runParentDir) => rm(runParentDir, { recursive: true, force: true })),
    );
  });

  it("seeds large thread fixtures through the real event store and projection pipeline", async () => {
    const seeded = await seedPerfState("large_threads");
    runParentDirsToCleanup.push(seeded.runParentDir);
    const scenario = getPerfSeedScenario("large_threads");

    expect(seeded.snapshot.projects).toHaveLength(5);
    expect(seeded.snapshot.threads).toHaveLength(30);
    expect(seeded.baseDir).toBe(join(seeded.runParentDir, "base"));
    expect(new Set(seeded.snapshot.threads.map((thread) => thread.projectId)).size).toBe(5);

    const heavyThread = seeded.snapshot.threads.find(
      (thread) => thread.id === PERF_CATALOG_IDS.largeThreads.heavyAThreadId,
    );
    const heavyThreadScenario = scenario.threads.find(
      (thread) => thread.id === PERF_CATALOG_IDS.largeThreads.heavyAThreadId,
    );
    expect(heavyThread?.messages).toHaveLength(2_000);
    expect(heavyThreadScenario?.turnCount ?? Number.POSITIVE_INFINITY).toBeLessThan(100);
    expect((heavyThread?.activities.length ?? 0) > 0).toBe(true);
    expect((heavyThread?.proposedPlans.length ?? 0) > 0).toBe(true);
    expect((heavyThread?.checkpoints.length ?? 0) >= 20).toBe(true);
    expect((heavyThread?.checkpoints[0]?.files.length ?? 0) >= 12).toBe(true);
  });

  it("enables assistant streaming in the burst base seed for websocket perf runs", async () => {
    const seeded = await seedPerfState("burst_base");
    runParentDirsToCleanup.push(seeded.runParentDir);

    const rawSettings = await readFile(join(seeded.baseDir, "userdata/settings.json"), "utf8");
    expect(JSON.parse(rawSettings)).toMatchObject({
      enableAssistantStreaming: true,
    });
  });
});
