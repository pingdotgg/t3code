// @effect-diagnostics nodeBuiltinImport:off - verifies Vitest discovery in a disposable project.
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { shardedTestFiles } from "./sharded-tests.ts";

it("uses the configured sequencer and discovers every file exactly once", async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "test-shards-")),
  );
  try {
    await NodeFSP.mkdir(NodePath.join(root, "node_modules"));
    await NodeFSP.symlink(
      NodePath.resolve(import.meta.dirname, "../../node_modules/vite-plus"),
      NodePath.join(root, "node_modules/vite-plus"),
      "dir",
    );
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
    await NodeFSP.writeFile(
      NodePath.join(root, "vite.config.ts"),
      `import {BaseSequencer} from "vite-plus/test/node";
       class Sequencer extends BaseSequencer {
         async shard(files) {
           const {index,count}=this.ctx.config.shard;
           return files.sort((a,b)=>a.moduleId.localeCompare(b.moduleId)).filter((_,i)=>i%count===index-1);
         }
       }
       export default {test:{include:["included/*.{test,spec}.ts"],sequence:{sequencer:Sequencer}}};`,
    );
    await NodeFSP.mkdir(NodePath.join(root, "included"));
    for (const file of [
      "included/a.test.ts",
      "included/b.test.ts",
      "included/c.test.ts",
      "included/d.spec.ts",
      "excluded.test.ts",
    ]) {
      await NodeFSP.writeFile(NodePath.join(root, file), "export {};");
    }
    const first = await shardedTestFiles(root, "1/2");
    const second = await shardedTestFiles(root, "2/2");
    expect(first).toEqual(
      ["a", "c"].map((file) => NodePath.join(root, `included/${file}.test.ts`)),
    );
    expect(second).toEqual([
      NodePath.join(root, "included/b.test.ts"),
      NodePath.join(root, "included/d.spec.ts"),
    ]);
    expect(new Set([...first, ...second]).size).toBe(4);
    await expect(shardedTestFiles(root, "0/2")).rejects.toThrow("Shard must be");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
