import { WORKER_ENTRY_PREFIX } from "@alchemy.run/cloudflare-runtime/rolldown/plugins";
import * as NodeFsPromises from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import type * as ViteModule from "vite";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeIntegrationPluginOptions,
  SERVER_ENTRYPOINT,
} from "../cloudflare.ts";
import { createWorkerdPrerenderEnvironmentPlugin } from "../prerender-environment.ts";
import { collectOutputModules } from "../prerenderer.ts";

describe("makeIntegrationPluginOptions (workerd prerendering)", () => {
  it("promotes prerender to a child worker environment during a workerd build", () => {
    const options = makeIntegrationPluginOptions(undefined, {
      prerenderEnvironment: "workerd",
      command: "build",
    });
    expect(options.viteEnvironments).toEqual({
      entry: "ssr",
      children: ["prerender"],
    });
    expect(options.skipEnvironments).toEqual(["astro"]);
  });

  it("filters a user-supplied prerender skip during a workerd build", () => {
    const options = makeIntegrationPluginOptions(
      { skipEnvironments: ["custom", "prerender"] },
      { prerenderEnvironment: "workerd", command: "build" },
    );
    expect(options.viteEnvironments).toEqual({
      entry: "ssr",
      children: ["prerender"],
    });
    expect(options.skipEnvironments).toEqual(["astro", "custom"]);
  });

  it("keeps prerender skipped in dev and in node mode", () => {
    for (const args of [
      { prerenderEnvironment: "workerd", command: "dev" },
      { prerenderEnvironment: "workerd", command: "sync" },
      { prerenderEnvironment: "node", command: "build" },
    ] as const) {
      const options = makeIntegrationPluginOptions(undefined, args);
      expect(options.viteEnvironments).toEqual({ entry: "ssr" });
      expect(options.skipEnvironments).toEqual(["astro", "prerender"]);
    }
  });
});

describe("createWorkerdPrerenderEnvironmentPlugin", () => {
  const configEnvironment = (
    plugin: ViteModule.Plugin,
    name: string,
  ): unknown => {
    const hook = plugin.configEnvironment;
    const handler = typeof hook === "function" ? hook : hook?.handler;
    if (!handler) throw new Error("configEnvironment hook missing");
    return handler.call(undefined as never, name, {} as never, {} as never);
  };

  it("assigns the worker-wrapped server entrypoint as the prerender build input", () => {
    const plugin = createWorkerdPrerenderEnvironmentPlugin(SERVER_ENTRYPOINT);
    expect(plugin.apply).toBe("build");
    expect(configEnvironment(plugin, "prerender")).toEqual({
      build: {
        rolldownOptions: {
          input: `${WORKER_ENTRY_PREFIX}${SERVER_ENTRYPOINT}`,
        },
      },
    });
  });

  it("leaves every other environment untouched", () => {
    const plugin = createWorkerdPrerenderEnvironmentPlugin(SERVER_ENTRYPOINT);
    for (const name of ["ssr", "client", "astro"]) {
      expect(configEnvironment(plugin, name)).toBeUndefined();
    }
  });
});

describe("collectOutputModules", () => {
  let dir: string | undefined;

  const makeOutputDir = async (
    files: Record<string, string | Uint8Array>,
  ): Promise<string> => {
    dir = await NodeFsPromises.mkdtemp(
      NodePath.join(NodeOs.tmpdir(), "astro-prerender-test-"),
    );
    for (const [relative, content] of Object.entries(files)) {
      const absolute = NodePath.join(dir, relative);
      await NodeFsPromises.mkdir(NodePath.dirname(absolute), {
        recursive: true,
      });
      await NodeFsPromises.writeFile(absolute, content);
    }
    return dir;
  };

  afterEach(async () => {
    if (dir !== undefined) {
      await NodeFsPromises.rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("loads the output with the prerender entry chunk first", async () => {
    const output = await makeOutputDir({
      "prerender-entry.C3POR2D2.mjs": "export default {};",
      "chunks/page_abc.mjs": "export const page = 1;",
      "chunks/zzz_last.mjs": "export const z = 1;",
      "chunks/page_abc.mjs.map": "{}",
      "_astro/styles.css": "body {}",
      "manifest.json": "{}",
      "data.bin": new Uint8Array([1, 2, 3]),
    });
    const modules = await collectOutputModules(output);
    expect(modules[0]).toMatchObject({
      name: "prerender-entry.C3POR2D2.mjs",
      type: "ESModule",
    });
    const byName = new Map(modules.map((module) => [module.name, module]));
    expect(byName.get("chunks/page_abc.mjs")).toMatchObject({
      type: "ESModule",
    });
    expect(byName.get("_astro/styles.css")).toMatchObject({ type: "Text" });
    expect(byName.get("manifest.json")).toMatchObject({ type: "Json" });
    expect(byName.get("data.bin")).toMatchObject({ type: "Data" });
    // Sourcemaps are never shipped to workerd.
    expect(byName.has("chunks/page_abc.mjs.map")).toBe(false);
    // Deterministic ordering after the entry.
    expect(modules.map((module) => module.name).slice(1)).toEqual(
      [...byName.keys()]
        .filter((name) => !name.startsWith("prerender-entry."))
        .sort(),
    );
  });

  it("fails with a clear error when the entry chunk is missing", async () => {
    const output = await makeOutputDir({
      "chunks/page_abc.mjs": "export const page = 1;",
    });
    await expect(collectOutputModules(output)).rejects.toThrow(
      /prerender-entry/,
    );
  });

  it("fails with a clear error when the output directory does not exist", async () => {
    await expect(
      collectOutputModules("/nonexistent/prerender-output"),
    ).rejects.toThrow(/prerender build output/);
  });
});
