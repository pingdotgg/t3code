// @effect-diagnostics nodeBuiltinImport:off - the test kills a real Node process to prove the cache is on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

it.each([false, true])(
  "persists an enabled cache before forced exit (disabled: %s)",
  async (disabled) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-compile-cache-"));
    try {
      const cacheDirectory = NodePath.join(directory, "cache");
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
const { flushCompileCache } = await import(${JSON.stringify(new URL("./compileCache.ts", import.meta.url).href)});
await Effect.runPromise(flushCompileCache);
process.kill(process.pid, "SIGKILL");`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_COMPILE_CACHE: cacheDirectory,
            NODE_DISABLE_COMPILE_CACHE: disabled ? "1" : undefined,
          },
        },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.stderr, "");
      assert.notEqual(child.status, 0);
      const entries = await NodeFSP.readdir(cacheDirectory, { recursive: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      const files = await Promise.all(
        entries.map((entry) => NodeFSP.stat(NodePath.join(cacheDirectory, entry))),
      );
      assert.equal(
        files.some((entry) => entry.isFile()),
        !disabled,
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
