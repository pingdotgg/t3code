// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { cacheKey, seedPreparedCache } from "./server-compile-cache.ts";

it.each([
  { platform: "freebsd", hostArch: "x64", arch: 1, reason: "unsupported target freebsd" },
  { platform: "linux", hostArch: "x64", arch: 3, reason: "unexecutable target linux/arm64" },
  { platform: "linux", hostArch: "arm64", arch: 1, reason: "unexecutable target linux/x64" },
  { platform: "darwin", hostArch: "arm64", arch: 3, reason: "untrusted bundle", untrusted: true },
])(
  "skips cache generation for $reason",
  async ({ platform, hostArch, arch, reason, untrusted }) => {
    const { spawnSync } = await import("node:child_process");
    const hook = NodeURL.fileURLToPath(
      new URL("../prepare-server-compile-cache.cjs", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
       Object.defineProperty(process, "arch", { value: ${JSON.stringify(hostArch)} });
       require(${JSON.stringify(hook)})({ electronPlatformName: ${JSON.stringify(platform)}, arch: ${arch} }).catch(error => { console.error(error); process.exitCode = 1; });`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, T3CODE_DESKTOP_UNTRUSTED_BUNDLE: untrusted ? "true" : "" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Skipping ${reason}`);
  },
);

// macOS runs on an ARM64 host to exercise the Rosetta build-host check.
it.each([
  {
    platform: "darwin",
    hostArch: "arm64",
    arch: 1,
    resources: "Fixture.app/Contents/Resources",
    executable: "Fixture.app/Contents/MacOS/Fixture",
  },
  { platform: "linux", hostArch: "x64", arch: 1, resources: "resources", executable: "fixture" },
  { platform: "linux", hostArch: "arm64", arch: 3, resources: "resources", executable: "fixture" },
])("prepares $platform/$hostArch cache", async ({ platform, hostArch, arch, ...layout }) => {
  const { spawnSync } = await import("node:child_process");
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hook-cache-")),
  );
  try {
    const resources = NodePath.join(root, layout.resources);
    const archive = NodePath.join(resources, "app.asar");
    const dist = NodePath.join(archive, "apps/server/dist");
    const helper = NodePath.join(archive, "apps/desktop/dist-electron/serverCompileCache.cjs");
    NodeFS.mkdirSync(dist, { recursive: true });
    NodeFS.mkdirSync(NodePath.dirname(helper), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dist, "binCli-fixture.mjs"), "export const answer = 42;");
    NodeFS.writeFileSync(NodePath.join(dist, "server-fixture.mjs"), "export const answer = 43;");
    NodeFS.writeFileSync(
      helper,
      `module.exports = require(${JSON.stringify(NodeURL.fileURLToPath(new URL("./server-compile-cache.ts", import.meta.url)))});`,
    );
    const hook = NodeURL.fileURLToPath(
      new URL("../prepare-server-compile-cache.cjs", import.meta.url),
    );
    // Node stands in for the packaged engine.
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const childProcess = require("node:child_process");
      const spawn = childProcess.spawnSync;
      childProcess.spawnSync = (executable, args, options) => {
        require("node:assert/strict").equal(executable, ${JSON.stringify(NodePath.join(root, layout.executable))});
        return spawn(process.execPath, args, options);
      };
      Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
      Object.defineProperty(process, "arch", { value: ${JSON.stringify(hostArch)} });
      require(${JSON.stringify(hook)})({
        appOutDir: ${JSON.stringify(root)}, electronPlatformName: ${JSON.stringify(platform)}, arch: ${arch},
        packager: { appInfo: { productFilename: "Fixture" }, executableName: "fixture" }
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(resources, "server-compile-cache/manifest.json"), "utf8"),
    );
    expect(
      manifest.entries.sort((a: { module: string }, b: { module: string }) =>
        a.module.localeCompare(b.module),
      ),
    ).toEqual([
      {
        module: "app.asar/apps/server/dist/binCli-fixture.mjs",
        file: expect.stringMatching(/^[a-f0-9]{8}$/),
      },
      {
        module: "app.asar/apps/server/dist/server-fixture.mjs",
        file: expect.stringMatching(/^[a-f0-9]{8}$/),
      },
    ]);
    expect(
      NodeFS.statSync(NodePath.join(resources, "server-compile-cache", manifest.entries[0].file))
        .size,
    ).toBeGreaterThan(0);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("rejects ambiguous bundled server entries before importing them", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cache-ambiguous-"));
  try {
    const dist = NodePath.join(root, "app.asar/apps/server/dist");
    NodeFS.mkdirSync(dist, { recursive: true });
    for (const file of ["binCli-fixture.mjs", "server-fixture.mjs", "server-unrelated.mjs"]) {
      NodeFS.writeFileSync(NodePath.join(dist, file), "throw Error('Unexpected import');");
    }
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {generatePreparedServerCache} from ${JSON.stringify(new URL("./server-compile-cache.ts", import.meta.url).href)}; await generatePreparedServerCache(${JSON.stringify(root)});`,
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
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Ambiguous bundled server entry");
    expect(NodeFS.existsSync(NodePath.join(root, "server-compile-cache/manifest.json"))).toBe(
      false,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("reclaims only AppImage cache directories linked to gone mounts", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cache-reclaim-")),
  );
  try {
    const resources = NodePath.join(root, ".mount_live/resources");
    const prepared = NodePath.join(resources, "server-compile-cache");
    const cacheRoot = NodePath.join(root, "cache");
    const server = NodePath.join(cacheRoot, "server");
    NodeFS.mkdirSync(prepared, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(prepared, "manifest.json"), "{}");
    NodeFS.writeFileSync(NodePath.join(prepared, "12345678"), "live bytes");
    const gone = NodePath.join(root, ".mount_gone/resources/server-compile-cache/12345678");
    for (const [name, targets] of [
      ["appimage-stale", [gone]],
      ["appimage-live", [NodePath.join(prepared, "12345678")]],
      ["appimage-live-damaged", [NodePath.join(prepared, "87654321")]],
      ["appimage-mixed", [gone, NodePath.join(prepared, "12345678")]],
      ["appimage-unrelated", [NodePath.join(root, "unrelated-missing")]],
      ["other-cache", [gone]],
      ["appimage-initializing", []],
    ] as const) {
      const active = NodePath.join(server, name, "v24-engine-uid");
      NodeFS.mkdirSync(active, { recursive: true });
      targets.forEach((target, index) =>
        NodeFS.symlinkSync(target, NodePath.join(active, index === 0 ? "12345678" : "87654321")),
      );
      NodeFS.writeFileSync(NodePath.join(active, "abcdef01"), "runtime replacement");
    }
    NodeFS.symlinkSync(
      NodePath.join(server, "other-cache"),
      NodePath.join(server, "appimage-directory-link"),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `process.env.APPIMAGE = "fixture"; import {enablePreparedServerCache} from ${JSON.stringify(new URL("./server-compile-cache.ts", import.meta.url).href)}; if (!enablePreparedServerCache(${JSON.stringify(NodePath.join(resources, "app.asar/apps/server/dist/binCli-fixture.mjs"))}, ${JSON.stringify(cacheRoot)})) throw Error("cache disabled");`,
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
    expect(result.status, result.stderr).toBe(0);
    expect(NodeFS.readdirSync(server).sort()).toEqual([
      "appimage-directory-link",
      "appimage-initializing",
      "appimage-live",
      "appimage-live-damaged",
      "appimage-mixed",
      "appimage-unrelated",
      "other-cache",
    ]);
    expect(NodeFS.readFileSync(NodePath.join(prepared, "12345678"), "utf8")).toBe("live bytes");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
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
      NodeFS.writeFileSync(
        NodePath.join(producer, relative),
        "export const answer = 42; export const loadServer = () => import('./server-fixture.mjs');",
      );
      NodeFS.writeFileSync(
        NodePath.join(producer, `${archive}.asar/apps/server/dist/server-fixture.mjs`),
        "export const answer = 43;",
      );
      run(
        `import {generatePreparedServerCache} from ${JSON.stringify(helper)}; await generatePreparedServerCache(${JSON.stringify(producer)});`,
      );
      NodeFS.cpSync(producer, consumer, { recursive: true });
      const consume = (home: string, appImage = false) =>
        run(
          `if (${appImage}) process.env.APPIMAGE = "fixture"; import {enablePreparedServerCache} from ${JSON.stringify(helper)}; import {pathToFileURL} from 'node:url'; if(!enablePreparedServerCache(${JSON.stringify(NodePath.join(consumer, relative))},${JSON.stringify(NodePath.join(root, home))})) throw Error('cache disabled'); const m = await import(pathToFileURL(${JSON.stringify(NodePath.join(consumer, relative))}).href); if(m.answer!==42 || (await m.loadServer()).answer!==43) throw Error('source fallback failed');`,
        );
      const prepared = NodePath.join(consumer, "server-compile-cache");
      NodeFS.chmodSync(prepared, 0o555);
      try {
        const first = consume("first-user");
        expect(first).toMatch(/binCli-fixture\.mjs was accepted/);
        expect(first).toMatch(/server-fixture\.mjs was accepted/);
        expect(consume("appimage-user", true)).toContain("was accepted");
        expect(NodeFS.readdirSync(NodePath.join(root, "appimage-user", "server"))).toEqual([]);
      } finally {
        NodeFS.chmodSync(prepared, 0o755);
      }
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
