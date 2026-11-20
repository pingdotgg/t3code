// @effect-diagnostics nodeBuiltinImport:off - Vitest discovery runs outside the application runtime.
import * as NodePath from "node:path";
import { createVitest } from "vite-plus/test/node";

export async function shardedTestFiles(root: string, shard: string) {
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || index > count) {
    throw new Error("Shard must be index/count with 1 <= index <= count");
  }
  const context = await createVitest("test", { root, watch: false, shard });
  try {
    const files = await context.globTestSpecifications();
    const sequencer = new context.config.sequence.sequencer(context);
    const selected = await sequencer.shard(files);
    return selected.map((file) => NodePath.resolve(file.moduleId));
  } finally {
    await context.close();
  }
}
