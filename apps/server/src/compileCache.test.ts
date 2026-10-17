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

it.each([
  { disabledBy: undefined },
  { disabledBy: "NODE_DISABLE_COMPILE_CACHE" },
  { disabledBy: "APPIMAGE" },
] as const)(
  "selects the CLI cache under the explicit T3 home (disabled by: $disabledBy)",
  async ({ disabledBy }) => {
    const disabled = disabledBy !== undefined;
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cli-cache-"));
    try {
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
const { enableCliCompileCache } = await import(${JSON.stringify(new URL("./cliCompileCache.ts", import.meta.url).href)});
enableCliCompileCache({ bundled: true, argv: ["serve", "--base-dir", ${JSON.stringify(directory)}], environment: process.env, version: "1.2.3" });
await import(${JSON.stringify(import.meta.resolve("effect/Effect"))});
const { flushCompileCache } = await import(${JSON.stringify(new URL("./compileCache.ts", import.meta.url).href)});
const Effect = await import(${JSON.stringify(import.meta.resolve("effect/Effect"))});
await Effect.runPromise(flushCompileCache);
process.kill(process.pid, "SIGKILL");`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_COMPILE_CACHE: undefined,
            NODE_DISABLE_COMPILE_CACHE:
              disabledBy === "NODE_DISABLE_COMPILE_CACHE" ? "1" : undefined,
            APPIMAGE: disabledBy === "APPIMAGE" ? "/opt/T3-Code.AppImage" : undefined,
          },
        },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.stderr, "");
      const cacheDirectory = NodePath.join(directory, "compile-cache", "1.2.3");
      const entries = await NodeFSP.readdir(cacheDirectory, {
        recursive: true,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
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

it("removes another version's CLI cache directory only after a week unused", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cli-cache-"));
  try {
    const root = NodePath.join(directory, "compile-cache");
    for (const version of ["1.2.2", "1.2.4"]) {
      await NodeFSP.mkdir(NodePath.join(root, version, "node"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(root, version, "node", "entry"), version);
    }
    // 1.2.2 was last used eight days ago; 1.2.4 is another install still in use.
    const { mtimeMs } = await NodeFSP.stat(NodePath.join(root, "1.2.2"));
    const eightDaysAgo = (mtimeMs - 8 * 24 * 60 * 60 * 1000) / 1000;
    await NodeFSP.utimes(NodePath.join(root, "1.2.2"), eightDaysAgo, eightDaysAgo);
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
const { enableCliCompileCache } = await import(${JSON.stringify(new URL("./cliCompileCache.ts", import.meta.url).href)});
enableCliCompileCache({ bundled: true, argv: ["serve", "--base-dir", ${JSON.stringify(directory)}], environment: process.env, version: "1.2.3" });`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_COMPILE_CACHE: undefined,
          NODE_DISABLE_COMPILE_CACHE: undefined,
        },
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.stderr, "");
    assert.deepEqual((await NodeFSP.readdir(root)).sort(), ["1.2.3", "1.2.4"]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
