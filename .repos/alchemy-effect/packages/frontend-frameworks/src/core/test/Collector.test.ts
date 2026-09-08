import * as Effect from "effect/Effect";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as vite from "vite";
import { describe, expect, it } from "vitest";
import {
  collectExternalWorkspaces,
  makeBuildOutputCollector,
  readServerModulesFromDisk,
  selectEntryByFacade,
  sortServerModules,
  WORKER_ENTRY_PREFIX,
  type BuildOutputCollector,
  type CollectorOptions,
} from "../index.ts";
import { makeProject, run } from "./helpers.ts";

const makeCollector = (options?: CollectorOptions) =>
  run(makeBuildOutputCollector(options));

interface BuildEnvironment {
  readonly outDir: string;
  readonly input: Record<string, string>;
}

const build = async (
  root: string,
  collector: BuildOutputCollector,
  environments: Record<string, BuildEnvironment>,
  plugins: Array<vite.Plugin> = [],
) => {
  const builder = await vite.createBuilder(
    {
      root,
      logLevel: "silent",
      plugins: [...plugins, collector.plugin],
      environments: Object.fromEntries(
        Object.entries(environments).map(([name, environment]) => [
          name,
          {
            build: {
              outDir: environment.outDir,
              minify: false,
              rollupOptions: { input: environment.input },
            },
          },
        ]),
      ),
      builder: {
        buildApp: async (builder) => {
          for (const name of Object.keys(environments)) {
            await builder.build(builder.environments[name]!);
          }
        },
      },
    },
    null,
  );
  await builder.buildApp();
};

const workerEntryPlugin = (realEntry: string): vite.Plugin => {
  const id = `${WORKER_ENTRY_PREFIX}${realEntry}`;
  return {
    name: "test:worker-entry",
    resolveId(source) {
      if (source === "virtual:worker-entry" || source === id) return id;
    },
    load(source) {
      if (source === id)
        return `export { default } from ${JSON.stringify(realEntry)};`;
    },
  };
};

describe("makeBuildOutputCollector", () => {
  it("collects server modules entry-first with hashes", async () => {
    const root = await makeProject({
      "shared.ts": `export const shared = "shared";`,
      "entry.ts": `import { shared } from "./shared.ts";\nexport default { fetch: () => new Response(shared) };`,
    });
    const collector = await makeCollector();
    await build(root, collector, {
      ssr: {
        outDir: "dist/server",
        input: { index: NodePath.join(root, "entry.ts") },
      },
    });
    const output = await run(collector.collect());
    expect(output.distDirectory).toBe(NodePath.join(root, "dist"));
    expect(output.serverModules).toBeDefined();
    expect(output.serverModules![0]!.name).toBe("server/index.js");
    for (const module of output.serverModules!) {
      expect(module.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof module.content).toBe("string");
    }
    expect(output.externalWorkspaces.size).toBe(0);
  });

  it("captures the client directory", async () => {
    const root = await makeProject({
      "client.ts": `console.log("client");`,
      "entry.ts": `export default { fetch: () => new Response("ok") };`,
    });
    const collector = await makeCollector();
    await build(root, collector, {
      client: {
        outDir: "dist/client",
        input: { main: NodePath.join(root, "client.ts") },
      },
      ssr: {
        outDir: "dist/server",
        input: { index: NodePath.join(root, "entry.ts") },
      },
    });
    const output = await run(collector.collect());
    expect(output.clientDirectory).toBe(NodePath.join(root, "dist/client"));
    // Client chunks must not leak into serverModules.
    expect(
      output.serverModules!.every((module) =>
        module.name.startsWith("server/"),
      ),
    ).toBe(true);
  });

  it("returns no server modules for a client-only build", async () => {
    const root = await makeProject({
      "client.ts": `console.log("client");`,
    });
    const collector = await makeCollector();
    await build(root, collector, {
      client: {
        outDir: "dist/client",
        input: { main: NodePath.join(root, "client.ts") },
      },
    });
    const output = await run(collector.collect());
    expect(output.serverModules).toBeUndefined();
    expect(output.clientDirectory).toBe(NodePath.join(root, "dist/client"));
  });

  it("skips environments listed in skipEnvironments", async () => {
    const root = await makeProject({
      "entry.ts": `export default { fetch: () => new Response("ok") };`,
      "prerender.ts": `export const prerender = () => "prerendered";`,
    });
    const collector = await makeCollector({ skipEnvironments: ["prerender"] });
    await build(root, collector, {
      ssr: {
        outDir: "dist/server",
        input: { index: NodePath.join(root, "entry.ts") },
      },
      prerender: {
        outDir: "dist/prerender",
        input: { prerender: NodePath.join(root, "prerender.ts") },
      },
    });
    const output = await run(collector.collect());
    expect(
      output.serverModules!.every((module) =>
        module.name.startsWith("server/"),
      ),
    ).toBe(true);
    // The skipped environment still built to disk — it is only excluded from the output.
    const prerenderOut = await NodeFsPromises.readdir(
      NodePath.join(root, "dist/prerender"),
    );
    expect(prerenderOut.length).toBeGreaterThan(0);
  });

  it("pins the server entry to the wrapped worker-entry module when the entry environment emits multiple entry chunks", async () => {
    const root = await makeProject({
      "real-entry.ts": `export default { fetch: () => new Response("worker") };`,
      "index.ts": `export const index = "not the worker entry";`,
      "build.ts": `export const build = "not the worker entry either";`,
    });
    const entry = NodePath.join(root, "real-entry.ts");
    const collector = await makeCollector();
    await build(
      root,
      collector,
      {
        ssr: {
          outDir: "dist/server",
          input: {
            // The wrapped entry comes FIRST so naive last-iterated-wins
            // selection would pick one of the plain entries.
            "entry.server": "virtual:worker-entry",
            index: NodePath.join(root, "index.ts"),
            build: NodePath.join(root, "build.ts"),
          },
        },
      },
      [workerEntryPlugin(entry)],
    );
    const output = await run(collector.collect());
    expect(output.serverModules![0]!.name).toBe("server/entry.server.js");
  });

  it("prefers a selectEntry match over the worker-entry facade", async () => {
    const root = await makeProject({
      "real-entry.ts": `export default { fetch: () => new Response("worker") };`,
      "index.ts": `export const index = "index";`,
    });
    const collector = await makeCollector({
      selectEntry: (chunk) => chunk.fileName === "index.js",
    });
    await build(
      root,
      collector,
      {
        ssr: {
          outDir: "dist/server",
          input: {
            "entry.server": "virtual:worker-entry",
            index: NodePath.join(root, "index.ts"),
          },
        },
      },
      [workerEntryPlugin(NodePath.join(root, "real-entry.ts"))],
    );
    const output = await run(collector.collect());
    expect(output.serverModules![0]!.name).toBe("server/index.js");
  });

  it("reads externally written modules referenced as external imports (RSC manifests)", async () => {
    const root = await makeProject({
      "entry.ts": `import manifest from "virtual:vite-rsc/assets-manifest";\nexport default { fetch: () => new Response(JSON.stringify(manifest)) };`,
    });
    const externalManifest: vite.Plugin = {
      name: "test:rsc-external",
      resolveId(source) {
        if (source === "virtual:vite-rsc/assets-manifest") {
          return { id: source, external: true };
        }
      },
    };
    const collector = await makeCollector();
    await build(
      root,
      collector,
      {
        ssr: {
          outDir: "dist/server",
          input: { index: NodePath.join(root, "entry.ts") },
        },
      },
      [externalManifest],
    );
    // Simulate the framework writing the manifest after the bundler finishes.
    await NodeFsPromises.writeFile(
      NodePath.join(root, "dist/server/__vite_rsc_assets_manifest.js"),
      `export default { written: "after writeBundle" };`,
    );
    const output = await run(collector.collect());
    const manifest = output.serverModules!.find(
      (module) => module.name === "server/__vite_rsc_assets_manifest.js",
    );
    expect(manifest).toBeDefined();
    expect(manifest!.content).toContain("after writeBundle");
  });

  it("re-reads server modules from disk with collect({ fromDisk: true })", async () => {
    const root = await makeProject({
      "entry.ts": `export default { fetch: () => new Response("ok") };`,
    });
    const collector = await makeCollector();
    await build(root, collector, {
      ssr: {
        outDir: "dist/server",
        input: { index: NodePath.join(root, "entry.ts") },
      },
    });
    // Simulate a framework rewriting + adding server modules after buildApp
    // (waku's prune step + __waku_build_metadata.js).
    const pruned = `// Pruned by the framework - content cached at build time.`;
    await NodeFsPromises.writeFile(
      NodePath.join(root, "dist/server/index.js"),
      pruned,
    );
    await NodeFsPromises.writeFile(
      NodePath.join(root, "dist/server/__build_metadata.js"),
      `export default { metadata: true };`,
    );
    await NodeFsPromises.mkdir(NodePath.join(root, "dist/server/assets"), {
      recursive: true,
    });
    await NodeFsPromises.writeFile(
      NodePath.join(root, "dist/server/assets/data.bin"),
      Buffer.from([0, 1, 2, 255]),
    );
    const output = await run(collector.collect({ fromDisk: true }));
    const names = output.serverModules!.map((module) => module.name);
    expect(names[0]).toBe("server/index.js");
    expect(names).toContain("server/__build_metadata.js");
    expect(names).toContain("server/assets/data.bin");
    const entry = output.serverModules![0]!;
    expect(entry.content).toBe(pruned);
    const binary = output.serverModules!.find(
      (module) => module.name === "server/assets/data.bin",
    );
    expect(Buffer.isBuffer(binary!.content)).toBe(true);
    expect(Array.from(binary!.content as Buffer)).toEqual([0, 1, 2, 255]);
  });

  it("fails collect({ fromDisk: true }) when the entry disappeared from disk", async () => {
    const root = await makeProject({
      "entry.ts": `export default { fetch: () => new Response("ok") };`,
    });
    const collector = await makeCollector();
    await build(root, collector, {
      ssr: {
        outDir: "dist/server",
        input: { index: NodePath.join(root, "entry.ts") },
      },
    });
    await NodeFsPromises.rm(NodePath.join(root, "dist/server/index.js"));
    const result = await run(
      Effect.result(collector.collect({ fromDisk: true })),
    );
    expect(result._tag).toBe("Failure");
  });

  it("collects external workspaces for modules imported from outside the root", async () => {
    const base = await makeProject({
      "ext/package.json": JSON.stringify({ name: "ext", type: "module" }),
      "ext/src/mod.ts": `export const external = "external";`,
      "app/entry.ts": `import { external } from "../ext/src/mod.ts";\nexport default { fetch: () => new Response(external) };`,
    });
    const root = NodePath.join(base, "app");
    const collector = await makeCollector();
    await build(root, collector, {
      ssr: {
        outDir: "dist/server",
        input: { index: NodePath.join(root, "entry.ts") },
      },
    });
    const output = await run(collector.collect());
    expect(Array.from(output.externalWorkspaces)).toContain(
      NodePath.join(base, "ext"),
    );
  });
});

describe("readServerModulesFromDisk", () => {
  it("reads nested files with prefixed names", async () => {
    const root = await makeProject({
      "out/index.js": `export default {};`,
      "out/chunks/dep.js": `export const dep = 1;`,
      "out/data.bin": "\x00\x01",
    });
    const modules = await run(
      readServerModulesFromDisk({
        directory: NodePath.join(root, "out"),
        prefix: "server",
      }),
    );
    const sorted = sortServerModules(modules, "server/index.js");
    expect(sorted.map((module) => module.name)).toEqual([
      "server/index.js",
      "server/chunks/dep.js",
      "server/data.bin",
    ]);
    expect(typeof sorted[0]!.content).toBe("string");
    expect(Buffer.isBuffer(sorted[2]!.content)).toBe(true);
  });
});

describe("collectExternalWorkspaces", () => {
  it("resolves the nearest package.json directory and deduplicates", async () => {
    const base = await makeProject({
      "pkg/package.json": JSON.stringify({ name: "pkg" }),
      "pkg/src/a.ts": "",
      "pkg/src/nested/b.ts": "",
    });
    const workspaces = await run(
      collectExternalWorkspaces([
        NodePath.join(base, "pkg/src"),
        NodePath.join(base, "pkg/src/nested"),
      ]),
    );
    expect(Array.from(workspaces)).toEqual([NodePath.join(base, "pkg")]);
  });
});

describe("selectEntryByFacade", () => {
  const entry = NodePath.resolve("/project/src/worker-entry.ts");
  const chunk = (facadeModuleId: string | null) => ({
    fileName: "worker-entry.js",
    name: "server/worker-entry.js",
    facadeModuleId,
  });

  it("matches the plain facade module", () => {
    expect(selectEntryByFacade(entry)(chunk(entry))).toBe(true);
  });

  it("matches the wrapped worker-entry facade", () => {
    const posix = entry.replaceAll("\\", "/");
    expect(
      selectEntryByFacade(entry)(chunk(`${WORKER_ENTRY_PREFIX}${posix}`)),
    ).toBe(true);
  });

  it("rejects other chunks", () => {
    expect(
      selectEntryByFacade(entry)(chunk(NodePath.resolve("/project/other.ts"))),
    ).toBe(false);
    expect(selectEntryByFacade(entry)(chunk(null))).toBe(false);
  });
});

describe("WORKER_ENTRY_PREFIX", () => {
  it("matches the constant in @alchemy.run/cloudflare-runtime/rolldown", async () => {
    const plugins =
      await import("@alchemy.run/cloudflare-runtime/rolldown/plugins");
    expect(WORKER_ENTRY_PREFIX).toBe(plugins.WORKER_ENTRY_PREFIX);
  });
});
