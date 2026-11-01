// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { cacheKey, seedPreparedCache } from "./server-compile-cache.ts";

it.each(["x64", "arm64"])("skips prepared bytecode generation on Linux %s", async (arch) => {
  const { spawnSync } = await import("node:child_process");
  const hook = NodeURL.fileURLToPath(
    new URL("../prepare-server-compile-cache.cjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `Object.defineProperty(process, "platform", { value: "linux" });
       Object.defineProperty(process, "arch", { value: ${JSON.stringify(arch)} });
       require(${JSON.stringify(hook)})({ electronPlatformName: "linux", arch: ${arch === "x64" ? 1 : 3} }).catch(error => { console.error(error); process.exitCode = 1; });`,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Skipping unsupported target linux");
});

it("seeds relocated cache entries without allowing writes into shipped resources", () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-prepared-test-")),
  );
  try {
    const prepared = NodePath.join(root, "resources", "server-compile-cache");
    const active = NodePath.join(root, "user", "different-uid-tag");
    NodeFS.mkdirSync(prepared, { recursive: true });
    NodeFS.mkdirSync(active, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(prepared, "12345678"), "prepared bytes");
    const manifest = {
      format: 1,
      runtime: "matching",
      entries: [{ module: "app.asar/apps/server/dist/chunk.mjs", file: "12345678" }],
    };
    NodeFS.writeFileSync(NodePath.join(prepared, "manifest.json"), JSON.stringify(manifest));
    expect(seedPreparedCache(prepared, active, "wrong-engine")).toBe(false);
    expect(seedPreparedCache(prepared, active, "matching")).toBe(true);
    const key = cacheKey(active, NodePath.join(root, "resources", manifest.entries[0]!.module));
    expect(NodeFS.readFileSync(NodePath.join(active, key), "utf8")).toBe("prepared bytes");
    // Node persists by replacing the directory entry, never by overwriting the linked inode.
    NodeFS.rmSync(NodePath.join(active, key));
    NodeFS.writeFileSync(NodePath.join(active, key), "runtime replacement");
    expect(NodeFS.readFileSync(NodePath.join(prepared, "12345678"), "utf8")).toBe("prepared bytes");
    expect(seedPreparedCache(prepared, active, "matching")).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(active, key), "utf8")).toBe("runtime replacement");
    const missing = { module: "app.asar/apps/server/dist/missing.mjs", file: "87654321" };
    for (const entries of [
      [...manifest.entries, missing],
      [missing, ...manifest.entries],
    ]) {
      NodeFS.writeFileSync(
        NodePath.join(prepared, "manifest.json"),
        JSON.stringify({ ...manifest, entries }),
      );
      expect(seedPreparedCache(prepared, active, "matching")).toBe(false);
    }
    NodeFS.writeFileSync(NodePath.join(prepared, "manifest.json"), "corrupt");
    expect(seedPreparedCache(prepared, active, "matching")).toBe(false);
    expect(seedPreparedCache(NodePath.join(root, "missing"), active, "matching")).toBe(false);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it.each(["app", "server"])(
  "generates %s.asar cache with the consumer engine and falls back after damage",
  async (archive) => {
    const { spawnSync } = await import("node:child_process");
    const helper = new URL("./server-compile-cache.ts", import.meta.url).href;
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cache-engine-")),
    );
    const run = (code: string) => {
      const env = {
        ...process.env,
        NODE_DEBUG_NATIVE: "COMPILE_CACHE",
        NODE_COMPILE_CACHE: undefined,
        NODE_DISABLE_COMPILE_CACHE: undefined,
      };
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        env,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stderr;
    };
    try {
      const producer = NodePath.join(root, "producer", "resources");
      const consumer = NodePath.join(root, "relocated", "resources");
      const relative = `${archive}.asar/apps/server/dist/binCli-fixture.mjs`;
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(producer, relative)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(producer, relative), "export const answer = 42;");
      run(
        `import {generatePreparedServerCache} from ${JSON.stringify(helper)}; await generatePreparedServerCache(${JSON.stringify(producer)});`,
      );
      NodeFS.cpSync(producer, consumer, { recursive: true });
      const consume = (home: string, appImage = false) =>
        run(
          `if (${appImage}) process.env.APPIMAGE = "fixture"; import {enablePreparedServerCache} from ${JSON.stringify(helper)}; import {pathToFileURL} from 'node:url'; if(!enablePreparedServerCache(${JSON.stringify(NodePath.join(consumer, relative))},${JSON.stringify(NodePath.join(root, home))})) throw Error('cache disabled'); const m = await import(pathToFileURL(${JSON.stringify(NodePath.join(consumer, relative))}).href); if(m.answer!==42) throw Error('source fallback failed');`,
        );
      const prepared = NodePath.join(consumer, "server-compile-cache");
      NodeFS.chmodSync(prepared, 0o555);
      expect(consume("first-user")).toContain("was accepted");
      expect(consume("appimage-user", true)).toContain("was accepted");
      expect(NodeFS.readdirSync(NodePath.join(root, "appimage-user", "server"))).toEqual([]);
      NodeFS.chmodSync(prepared, 0o755);
      for (const file of NodeFS.readdirSync(prepared).filter((file) => file !== "manifest.json")) {
        NodeFS.writeFileSync(NodePath.join(prepared, file), "broken");
      }
      expect(consume("second-user")).toContain("was not initialized");
      for (const file of NodeFS.readdirSync(prepared).filter((file) => file !== "manifest.json")) {
        expect(NodeFS.readFileSync(NodePath.join(prepared, file), "utf8")).toBe("broken");
      }
      NodeFS.rmSync(prepared, { recursive: true });
      expect(consume("third-user")).toContain("was not initialized");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
