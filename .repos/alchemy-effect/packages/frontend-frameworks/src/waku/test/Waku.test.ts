import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import type * as ViteModule from "vite";
import { describe, expect, it } from "vitest";
import { mergeConfig } from "vite";
import framework, {
  DEFAULT_TARGET_SPECIFIER,
  layer,
  make,
  makeWakuConfigInput,
  makeWakuServerEntryPlugin,
  mergeUserWakuConfig,
  selectWakuTargetInput,
  WAKU_CONFIG_FILES,
  WAKU_SERVER_ENTRY_ID,
  WAKU_SERVER_ENTRY_MODULE,
  type WakuTarget,
} from "../index.ts";

const ADAPTER =
  "/project/node_modules/@alchemy.run/frontend-frameworks/dist/waku/adapter.js";

const flatten = (
  plugins: Array<ViteModule.PluginOption> | undefined,
): Array<ViteModule.Plugin> =>
  ((plugins ?? []) as Array<unknown>)
    .flat(8)
    .filter(
      (plugin): plugin is ViteModule.Plugin =>
        typeof plugin === "object" && plugin !== null && "name" in plugin,
    );

describe("makeWakuConfigInput", () => {
  it("defaults unstable_adapter to the target's adapter module", () => {
    const config = makeWakuConfigInput({ adapterPath: ADAPTER });
    expect(config.unstable_adapter).toBe(ADAPTER);
  });

  it("pins unstable_adapter to the target's adapter module (the caller rejects user adapters)", () => {
    const config = makeWakuConfigInput({
      adapterPath: ADAPTER,
      userConfig: { unstable_adapter: "/custom/adapter.ts" },
    });
    expect(config.unstable_adapter).toBe(ADAPTER);
  });

  it("injects the target's vite plugins ahead of user plugins", () => {
    const targetPlugin: ViteModule.Plugin = { name: "target-plugin" };
    const userPlugin: ViteModule.Plugin = { name: "user-plugin" };
    const config = makeWakuConfigInput({
      adapterPath: ADAPTER,
      plugins: [targetPlugin],
      userConfig: { vite: { plugins: [userPlugin] } },
    });
    const plugins = flatten(config.vite?.plugins);
    const targetIndex = plugins.findIndex(
      (plugin) => plugin.name === "target-plugin",
    );
    const userIndex = plugins.findIndex(
      (plugin) => plugin.name === "user-plugin",
    );
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeGreaterThan(targetIndex);
  });

  it("injects no plugins when the target provides none", () => {
    const config = makeWakuConfigInput({ adapterPath: ADAPTER });
    expect(flatten(config.vite?.plugins)).toEqual([]);
  });

  it("dedupes waku and hono so the adapter resolves the project's copies", () => {
    const config = makeWakuConfigInput({
      adapterPath: ADAPTER,
      userConfig: { vite: { resolve: { dedupe: ["react", "waku"] } } },
    });
    expect(config.vite?.resolve?.dedupe).toEqual(["waku", "hono", "react"]);
  });

  it("applies the rsc/ssr optimizeDeps includes and neutral platform", () => {
    const config = makeWakuConfigInput({ adapterPath: ADAPTER });
    const environments = config.vite?.environments as Record<
      string,
      ViteModule.EnvironmentOptions
    >;
    expect(environments.rsc?.optimizeDeps?.include).toContain("hono/tiny");
    expect(environments.ssr?.optimizeDeps?.include).toContain(
      "waku > rsc-html-stream/server",
    );
    expect(environments.rsc?.build?.rolldownOptions?.platform).toBe("neutral");
    expect(environments.ssr?.build?.rolldownOptions?.platform).toBe("neutral");
  });

  it("merges user environment config instead of clobbering it", () => {
    const config = makeWakuConfigInput({
      adapterPath: ADAPTER,
      userConfig: {
        vite: {
          environments: {
            rsc: { optimizeDeps: { include: ["extra-dep"] } },
            custom: { optimizeDeps: { include: ["custom-dep"] } },
          },
        },
      },
    });
    const environments = config.vite?.environments as Record<
      string,
      ViteModule.EnvironmentOptions
    >;
    expect(environments.rsc?.optimizeDeps?.include).toEqual([
      "hono/tiny",
      "extra-dep",
    ]);
    expect(environments.custom?.optimizeDeps?.include).toEqual(["custom-dep"]);
  });
});

describe("mergeUserWakuConfig", () => {
  const merge = (
    file: Parameters<typeof mergeUserWakuConfig>[0]["file"],
    inline: Parameters<typeof mergeUserWakuConfig>[0]["inline"],
  ) => mergeUserWakuConfig({ file, inline, mergeViteConfig: mergeConfig });

  it("probes the same config files as waku's CLI, in the same order", () => {
    expect(WAKU_CONFIG_FILES).toEqual(["waku.config.ts", "waku.config.js"]);
  });

  it("passes a lone file config or lone inline config through", () => {
    expect(merge({ basePath: "/docs/" }, undefined)).toStrictEqual({
      basePath: "/docs/",
    });
    expect(merge(undefined, { srcDir: "app" })).toStrictEqual({
      srcDir: "app",
    });
  });

  it("merges inline options over the file config per key", () => {
    expect(
      merge({ basePath: "/docs/", srcDir: "app" }, { srcDir: "source" }),
    ).toEqual({
      basePath: "/docs/",
      srcDir: "source",
    });
  });

  it("does not let explicit undefined inline keys clobber file values", () => {
    expect(
      merge({ srcDir: "app" }, { srcDir: undefined, distDir: "out" }),
    ).toEqual({
      srcDir: "app",
      distDir: "out",
    });
  });

  it("combines vite configs with vite's mergeConfig (file plugins first)", () => {
    const filePlugin = { name: "file-plugin" };
    const inlinePlugin = { name: "inline-plugin" };
    const merged = merge(
      { vite: { plugins: [filePlugin], base: "/docs/" } },
      { vite: { plugins: [inlinePlugin] } },
    );
    expect(merged?.vite?.base).toBe("/docs/");
    const names = flatten(merged?.vite?.plugins).map((plugin) => plugin.name);
    expect(names.indexOf("file-plugin")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("inline-plugin")).toBeGreaterThan(
      names.indexOf("file-plugin"),
    );
  });

  it("keeps the only vite config present", () => {
    const vite = { base: "/docs/" };
    expect(merge({ vite }, { srcDir: "app" })?.vite).toBe(vite);
    expect(merge({ srcDir: "app" }, { vite })?.vite).toBe(vite);
  });
});

describe("selectWakuTargetInput", () => {
  const makeTarget = (config: unknown): WakuTarget => ({
    platform: "test",
    config,
    adapter: () => Effect.succeed("/adapter.js"),
    vitePlugins: () => Effect.succeed([]),
  });

  it("defaults to the cloudflare target module specifier", () => {
    const { input, config } = selectWakuTargetInput();
    expect(input).toBe(DEFAULT_TARGET_SPECIFIER);
    expect(config).toBeUndefined();
  });

  it("feeds the deprecated vite alias to the default target", () => {
    const vite = { compatibilityDate: "2026-03-10" };
    const { input, config } = selectWakuTargetInput({ vite });
    expect(input).toBe(DEFAULT_TARGET_SPECIFIER);
    expect(config).toBe(vite);
  });

  it("reads the harness target-scoped carriage (worker wins over the vite alias)", () => {
    const worker = { compatibilityDate: "2026-03-10" };
    const { input, config } = selectWakuTargetInput({
      target: { name: "cloudflare", cloudflare: { worker } },
      vite: { compatibilityDate: "1999-01-01" },
    });
    expect(input).toBe(DEFAULT_TARGET_SPECIFIER);
    expect(config).toBe(worker);
  });

  it("falls back to the vite alias when the carriage has no worker config", () => {
    const vite = { compatibilityDate: "2026-03-10" };
    const { input, config } = selectWakuTargetInput({
      target: { name: "cloudflare" },
      vite,
    });
    expect(input).toBe(DEFAULT_TARGET_SPECIFIER);
    expect(config).toBe(vite);
  });

  it("passes an explicit target value through unchanged", () => {
    const target = makeTarget({ worker: { name: "explicit" } });
    const { input } = selectWakuTargetInput({ target });
    expect(input).toBe(target);
  });

  it("passes a target factory through with the vite alias as its config", () => {
    const factory = (config: unknown) => makeTarget(config);
    const vite = { compatibilityDate: "2026-03-10" };
    const { input, config } = selectWakuTargetInput({ target: factory, vite });
    expect(input).toBe(factory);
    expect(config).toBe(vite);
  });

  it("passes a target module specifier through", () => {
    const { input } = selectWakuTargetInput({ target: "@my/waku-aws" });
    expect(input).toBe("@my/waku-aws");
  });
});

describe("adapter fork", () => {
  it("drops the wrangler-writing build enhancer and never imports wrangler", async () => {
    const source = await NodeFsPromises.readFile(
      NodePath.resolve(import.meta.dirname, "../adapter.ts"),
      "utf8",
    );
    expect(source).toContain("buildEnhancers: []");
    expect(source).not.toContain("cloudflare-build-enhancer");
    expect(source).not.toMatch(/from\s+["']wrangler/);
    expect(source).not.toMatch(/import\(["']wrangler/);
  });
});

describe("framework factory", () => {
  it("default-exports a factory producing a Layer<Framework>", () => {
    expect(Layer.isLayer(framework({}))).toBe(true);
    expect(Layer.isLayer(layer())).toBe(true);
    // The alchemy-side FrameworkModule contract: `make` returns the service
    // implementation as an Effect.
    expect(Effect.isEffect(make())).toBe(true);
  });

  it("pins the server entry to waku's rsc index module", () => {
    expect(WAKU_SERVER_ENTRY_MODULE).toBe(NodePath.join("server", "index.js"));
  });
});

describe("virtual:waku/server-entry", () => {
  it("resolves the wrappable-handler id to the installed waku server entry", () => {
    const wakuDirectory = "/project/node_modules/waku";
    const plugin = makeWakuServerEntryPlugin(wakuDirectory);
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    expect(resolveId(WAKU_SERVER_ENTRY_ID)).toBe(
      NodePath.join(wakuDirectory, "dist/lib/vite-entries/entry.server.js"),
    );
    expect(resolveId("virtual:waku/other")).toBeUndefined();
    expect(resolveId("./src/worker-entry.ts")).toBeUndefined();
  });
});
