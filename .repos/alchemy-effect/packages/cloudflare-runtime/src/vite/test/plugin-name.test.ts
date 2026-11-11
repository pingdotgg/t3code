import path from "node:path";
import * as vite from "vite";
import { describe, expect, it, vi } from "vitest";
import cloudflareVitePlugin, {
  ALCHEMY_CLOUDFLARE_VITE_PLUGIN_NAME,
  OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME,
  disableOfficialCloudflareVitePlugins,
} from "../plugin.ts";

const root = path.join(import.meta.dirname, "fixtures");

const flattenPlugins = (plugins: ReadonlyArray<unknown>): Array<vite.Plugin> => {
  const flat: Array<vite.Plugin> = [];
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (entry && typeof entry === "object" && "name" in entry) {
      flat.push(entry as vite.Plugin);
    }
  };
  for (const entry of plugins) visit(entry);
  return flat;
};

const hasCloudflarePlugin = (plugins: ReadonlyArray<vite.Plugin>): boolean =>
  plugins.some(
    (plugin) =>
      plugin.name === OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME ||
      plugin.name.startsWith(`${OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME}:`),
  );

describe("alchemy Cloudflare Vite plugin name", () => {
  it("registers a prefixed presence plugin, not the official exact name", () => {
    const plugins = flattenPlugins([cloudflareVitePlugin({ main: "./worker-entry.ts" })]);
    expect(plugins.some((plugin) => plugin.name === ALCHEMY_CLOUDFLARE_VITE_PLUGIN_NAME)).toBe(
      true,
    );
    expect(plugins.some((plugin) => plugin.name === OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME)).toBe(
      false,
    );
    expect(hasCloudflarePlugin(plugins)).toBe(true);
  });

  it("no-ops official plugin hooks already present in config.plugins", async () => {
    const officialConfig = vi.fn(() => ({
      define: { "import.meta.official": JSON.stringify(true) },
    }));
    const officialResolved = vi.fn();
    const official: vite.Plugin = {
      name: OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME,
      enforce: "pre",
      config: officialConfig,
      configResolved: officialResolved,
    };

    let seenByLaterConfig = false;
    const scanner: vite.Plugin = {
      name: "vinext-style-scan",
      enforce: "pre",
      config(config) {
        seenByLaterConfig = hasCloudflarePlugin(flattenPlugins(config.plugins ?? []));
      },
    };

    const resolved = await vite.resolveConfig(
      {
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [official, scanner, cloudflareVitePlugin({ main: "./worker-entry.ts" })],
      },
      "serve",
    );

    // The root plugin still resolves its own config (running the user's
    // customizer), but what it returns is discarded.
    expect(officialConfig).toHaveBeenCalledTimes(1);
    expect(officialResolved).not.toHaveBeenCalled();
    expect(seenByLaterConfig).toBe(true);
    expect(resolved.define?.["import.meta.official"]).toBeUndefined();
    expect(
      resolved.plugins.some((plugin) => plugin.name === ALCHEMY_CLOUDFLARE_VITE_PLUGIN_NAME),
    ).toBe(true);
  });

  it("disables nested official child plugins by object identity", async () => {
    const childConfig = vi.fn();
    const child: vite.Plugin = {
      name: `${OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME}:compat`,
      config: childConfig,
    };
    const disabled = await disableOfficialCloudflareVitePlugins([[child]]);
    expect(disabled).toBe(1);
    void (child.config as () => void)();
    expect(childConfig).not.toHaveBeenCalled();
  });

  it("keeps the official root plugin's config resolution, which runs the user's customizer", async () => {
    const customizer = vi.fn();
    const official: vite.Plugin = {
      name: OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME,
      config: () => customizer(),
      configureServer: () => {},
    };
    const failing: vite.Plugin = {
      name: OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME,
      config: () => {
        throw new Error("no wrangler config");
      },
    };
    expect(await disableOfficialCloudflareVitePlugins([official, failing])).toBe(2);
    await (official.config as () => Promise<void>)();
    expect(customizer).toHaveBeenCalledTimes(1);
    await expect((failing.config as () => Promise<void>)()).resolves.toBeUndefined();
  });

  it("disables official plugins an async plugin factory resolves to", async () => {
    const configureServer = vi.fn();
    const applyToEnvironment = vi.fn(() => true);
    const official: vite.Plugin = {
      name: OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME,
      configureServer,
      applyToEnvironment,
    };
    const disabled = await disableOfficialCloudflareVitePlugins([
      Promise.resolve([{ name: "framework" }, official]),
    ]);
    expect(disabled).toBe(1);
    void (official.configureServer as () => void)();
    expect(configureServer).not.toHaveBeenCalled();
    expect((official.applyToEnvironment as () => boolean)()).toBe(false);
    expect(applyToEnvironment).not.toHaveBeenCalled();
  });
});
