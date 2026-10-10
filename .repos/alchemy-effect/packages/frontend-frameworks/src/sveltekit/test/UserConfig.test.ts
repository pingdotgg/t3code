import type { Adapter } from "@sveltejs/kit";
import type * as ViteModule from "vite";
import { describe, expect, it } from "vitest";
import {
  CONFIG_PLUGIN_NAME,
  DEFAULT_VITE_CONFIG_FILES,
  flattenPluginOption,
  makeSvelteKitConfigPlugin,
  mergeKitOptions,
  SVELTEKIT_SETUP_PLUGIN_NAME,
} from "../UserConfig.ts";

const makeAdapter = (name: string): Adapter => ({
  name,
  adapt: async () => {},
});

/**
 * A stand-in for the current SvelteKit `vite-plugin-sveltekit-setup` shape,
 * which exposes the validated Kit config directly through `api.options`.
 */
const makeSetupPlugin = (kit: Record<string, unknown>) =>
  ({
    name: SVELTEKIT_SETUP_PLUGIN_NAME,
    api: { options: kit },
  }) as ViteModule.Plugin;

/**
 * A stand-in for the legacy setup-plugin shape, where the validated Kit
 * config was nested under `api.options.kit`.
 */
const makeLegacySetupPlugin = (kit: Record<string, unknown>) =>
  ({
    name: SVELTEKIT_SETUP_PLUGIN_NAME,
    api: { options: { kit } },
  }) as ViteModule.Plugin;

const configEnv: ViteModule.ConfigEnv = {
  command: "build",
  mode: "production",
};

/** Run the injector's config hook the way Vite would. */
const runConfigHook = async (
  plugin: ViteModule.Plugin,
  config: ViteModule.UserConfig,
): Promise<void> => {
  const hook = plugin.config as {
    order?: string;
    handler: (
      config: ViteModule.UserConfig,
      env: ViteModule.ConfigEnv,
    ) => Promise<unknown>;
  };
  await hook.handler(config, configEnv);
};

describe("flattenPluginOption", () => {
  it("flattens nested arrays, promises, and falsy holes", async () => {
    const a = { name: "a" } as ViteModule.Plugin;
    const b = { name: "b" } as ViteModule.Plugin;
    const c = { name: "c" } as ViteModule.Plugin;
    const flattened = await flattenPluginOption([
      a,
      false,
      Promise.resolve([b, undefined, [null, Promise.resolve(c)]]),
    ]);
    expect(flattened.map((plugin) => plugin.name)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list for an absent option", async () => {
    expect(await flattenPluginOption(undefined)).toEqual([]);
  });
});

describe("mergeKitOptions", () => {
  it("merges nested plain objects key-by-key and replaces everything else", () => {
    const target: Record<string, unknown> = {
      alias: { $lib: "src/lib" },
      prerender: { entries: ["*"], concurrency: 1 },
      appDir: "_app",
    };
    mergeKitOptions(target, {
      alias: { $extra: "src/extra" },
      prerender: { entries: ["/about"] },
      appDir: "custom",
      ignored: undefined,
    });
    expect(target["alias"]).toEqual({
      $lib: "src/lib",
      $extra: "src/extra",
    });
    expect(target["prerender"]).toEqual({
      entries: ["/about"],
      concurrency: 1,
    });
    expect(target["appDir"]).toBe("custom");
    expect("ignored" in target).toBe(false);
  });
});

describe("makeSvelteKitConfigPlugin", () => {
  it("is pre-enforced with a pre-ordered config hook (must run before kit's setup hook)", () => {
    const plugin = makeSvelteKitConfigPlugin({
      adapter: makeAdapter("target-adapter"),
    });
    expect(plugin.name).toBe(CONFIG_PLUGIN_NAME);
    expect(plugin.enforce).toBe("pre");
    expect((plugin.config as { order?: string }).order).toBe("pre");
  });

  it("injects the deploy target's adapter into the user's sveltekit() config", async () => {
    const adapter = makeAdapter("target-adapter");
    const kit: Record<string, unknown> = {};
    const warnings: Array<string> = [];
    const plugin = makeSvelteKitConfigPlugin({
      adapter,
      warn: (m) => warnings.push(m),
    });

    // sveltekit() returns Promise<Plugin[]> — mirror that shape
    await runConfigHook(plugin, {
      plugins: [Promise.resolve([makeSetupPlugin(kit)])],
    });

    expect(kit["adapter"]).toBe(adapter);
    expect(warnings).toEqual([]);
  });

  it("supports the legacy nested api.options.kit shape", async () => {
    const adapter = makeAdapter("target-adapter");
    const kit: Record<string, unknown> = {};
    const plugin = makeSvelteKitConfigPlugin({ adapter });

    await runConfigHook(plugin, {
      plugins: [makeLegacySetupPlugin(kit)],
    });

    expect(kit["adapter"]).toBe(adapter);
  });

  it("replaces a user-declared adapter and warns", async () => {
    const adapter = makeAdapter("target-adapter");
    const kit: Record<string, unknown> = {
      adapter: makeAdapter("user-adapter"),
    };
    const warnings: Array<string> = [];
    const plugin = makeSvelteKitConfigPlugin({
      adapter,
      warn: (m) => warnings.push(m),
    });
    await runConfigHook(plugin, {
      plugins: [[makeSetupPlugin(kit)]],
    });
    expect(kit["adapter"]).toBe(adapter);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"user-adapter"');
    expect(warnings[0]).toContain("deploy target");
  });

  it("merges integration kit options over the user's (integration wins)", async () => {
    const adapter = makeAdapter("target-adapter");
    const kit: Record<string, unknown> = {
      alias: { $lib: "src/lib" },
      appDir: "_app",
    };
    const plugin = makeSvelteKitConfigPlugin({
      adapter,
      kit: {
        alias: { $fixture: "src/fixture" },
        appDir: "custom",
      },
    });
    await runConfigHook(plugin, {
      plugins: [makeSetupPlugin(kit)],
    });
    expect(kit["alias"]).toEqual({
      $lib: "src/lib",
      $fixture: "src/fixture",
    });
    expect(kit["appDir"]).toBe("custom");
    expect(kit["adapter"]).toBe(adapter);
  });

  it("warns for construction-time options it cannot apply late", async () => {
    const adapter = makeAdapter("target-adapter");
    const kit: Record<string, unknown> = {};
    const warnings: Array<string> = [];
    const plugin = makeSvelteKitConfigPlugin({
      adapter,
      kit: {
        preprocess: [],
        alias: { $x: "src/x" },
      },
      warn: (m) => warnings.push(m),
    });
    await runConfigHook(plugin, {
      plugins: [makeSetupPlugin(kit)],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"preprocess"');
    expect(kit["alias"]).toEqual({ $x: "src/x" });
  });

  it("fails clearly when the Vite config has no sveltekit() plugin", async () => {
    const plugin = makeSvelteKitConfigPlugin({
      adapter: makeAdapter("target-adapter"),
    });
    await expect(
      runConfigHook(plugin, {
        plugins: [{ name: "some-other-plugin" }],
      }),
    ).rejects.toThrow(/does not register the SvelteKit plugin/);
  });

  it("fails clearly when the setup plugin does not expose its options", async () => {
    const plugin = makeSvelteKitConfigPlugin({
      adapter: makeAdapter("target-adapter"),
    });
    await expect(
      runConfigHook(plugin, {
        plugins: [{ name: SVELTEKIT_SETUP_PLUGIN_NAME }],
      }),
    ).rejects.toThrow(/api\.options/);
  });
});

describe("DEFAULT_VITE_CONFIG_FILES", () => {
  it("mirrors Vite's default config discovery list", () => {
    expect(DEFAULT_VITE_CONFIG_FILES).toEqual([
      "vite.config.js",
      "vite.config.mjs",
      "vite.config.ts",
      "vite.config.cjs",
      "vite.config.mts",
      "vite.config.cts",
    ]);
  });
});
