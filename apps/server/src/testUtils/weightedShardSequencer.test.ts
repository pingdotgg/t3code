import { describe, expect, it } from "vite-plus/test";
import type { TestSpecification, Vitest } from "vite-plus/test/node";

import shardWeights from "./shardWeights.json" with { type: "json" };
import { WeightedShardSequencer } from "./weightedShardSequencer.ts";

const root = "/repo/apps/server";
const recordedSeconds: Readonly<Record<string, number>> = shardWeights;
const recorded = Object.keys(recordedSeconds);
const files = [...recorded, ...Array.from({ length: 300 }, (_, i) => `src/fast${i}.test.ts`)];
const specs = files.map((file) => ({ moduleId: `${root}/${file}` }) as TestSpecification);

const shardModuleIds = (count: number) =>
  Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const ctx = { config: { root, shard: { index: i + 1, count } } } as unknown as Vitest;
      const shard = await new WeightedShardSequencer(ctx).shard(specs);
      return shard.map((spec) => spec.moduleId);
    }),
  );

describe("WeightedShardSequencer", () => {
  it("runs every file in exactly one shard", async () => {
    const shards = await shardModuleIds(6);

    expect(shards.flat().toSorted()).toEqual(specs.map((spec) => spec.moduleId).toSorted());
  });

  it("puts each of the slowest files in a different shard", async () => {
    const slowest = new Set(
      recorded
        .toSorted((a, b) => (recordedSeconds[b] ?? 0) - (recordedSeconds[a] ?? 0))
        .slice(0, 6)
        .map((file) => `${root}/${file}`),
    );
    const shards = await shardModuleIds(6);

    for (const shard of shards) {
      expect(shard.filter((moduleId) => slowest.has(moduleId))).toHaveLength(1);
    }
  });
});
