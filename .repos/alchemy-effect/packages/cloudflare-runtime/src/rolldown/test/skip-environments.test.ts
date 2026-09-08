import type * as vite from "vite";
import { assert, describe, expect, it, vi } from "vitest";
import { parseViteEnvironments, type BasePluginOptions } from "../options.ts";
import {
  cloudflareExternalsPlugin,
  nodejsUnenvPlugin,
  optionsPlugin,
  virtualModulesPlugin,
} from "../plugins/index.ts";

const applyToEnvironment = (plugin: vite.Plugin | null, name: string) => {
  assert(plugin, "plugin is not defined");
  assert(
    typeof plugin.applyToEnvironment === "function",
    "plugin.applyToEnvironment is not a function",
  );
  return plugin.applyToEnvironment.call(
    plugin as never,
    { name } as unknown as Parameters<typeof plugin.applyToEnvironment>[0],
  );
};

const callConfigEnvironment = (plugin: vite.Plugin | null, name: string) => {
  assert(plugin, "plugin is not defined");
  const hook = plugin.configEnvironment;
  assert(hook, "plugin.configEnvironment is not defined");
  const handler = typeof hook === "function" ? hook : hook.handler;
  return handler.call(
    { meta: {} } as never,
    name,
    {} as never,
    { command: "serve", mode: "development" } as never,
  );
};

describe("skipEnvironments", () => {
  const options: BasePluginOptions = {
    compatibilityDate: "2025-07-01",
    compatibilityFlags: ["nodejs_compat"],
    skipEnvironments: ["prerender", "astro"],
  };

  it("excludes skipped environments (and client) from every per-environment plugin", () => {
    for (const factory of [
      optionsPlugin,
      cloudflareExternalsPlugin,
      nodejsUnenvPlugin,
      virtualModulesPlugin,
    ]) {
      const plugin = factory.vite(options);
      expect(applyToEnvironment(plugin, "ssr")).toBe(true);
      expect(applyToEnvironment(plugin, "client")).toBe(false);
      expect(applyToEnvironment(plugin, "prerender")).toBe(false);
      expect(applyToEnvironment(plugin, "astro")).toBe(false);
    }
  });

  it("gates configEnvironment away from skipped environments", async () => {
    const plugin = nodejsUnenvPlugin.vite(options);
    expect(await callConfigEnvironment(plugin, "prerender")).toBeUndefined();
    expect(await callConfigEnvironment(plugin, "astro")).toBeUndefined();
    const ssr = await callConfigEnvironment(plugin, "ssr");
    expect(ssr).toBeDefined();
    expect(
      (ssr as { resolve?: { builtins?: unknown } }).resolve?.builtins,
    ).toBeDefined();
  });

  it("keeps the client environment's special configEnvironment handling", async () => {
    const plugin = cloudflareExternalsPlugin.vite(options);
    expect(await callConfigEnvironment(plugin, "prerender")).toBeUndefined();
    const client = (await callConfigEnvironment(plugin, "client")) as {
      optimizeDeps?: { exclude?: Array<string> };
    };
    expect(client?.optimizeDeps?.exclude).toContain("cloudflare:workers");
  });

  it("rejects worker environments listed in skipEnvironments", () => {
    expect(() =>
      parseViteEnvironments({ skipEnvironments: ["ssr"] }),
    ).toThrowError(/cannot be both a worker environment/);
    expect(() =>
      parseViteEnvironments({
        viteEnvironments: { entry: "rsc", children: ["ssr"] },
        skipEnvironments: ["ssr"],
      }),
    ).toThrowError(/cannot be both a worker environment/);
    expect(() =>
      parseViteEnvironments({
        viteEnvironments: { entry: "rsc", children: ["ssr"] },
        skipEnvironments: ["prerender"],
      }),
    ).not.toThrow();
  });

  it("tolerates environments whose optimizer does not support registerMissingImport", async () => {
    const plugin = nodejsUnenvPlugin.vite(options);
    assert(plugin, "plugin is not defined");
    const configureServer = plugin.configureServer;
    assert(
      typeof configureServer === "function",
      "configureServer is not a function",
    );

    const registered: Array<string> = [];
    const makeEnvironment = (
      name: string,
      {
        noDiscovery = false,
        throws = false,
      }: { noDiscovery?: boolean; throws?: boolean } = {},
    ) => ({
      name,
      config: { optimizeDeps: { noDiscovery } },
      depsOptimizer: {
        init: async () => {},
        registerMissingImport: (id: string) => {
          if (throws) {
            throw new Error(
              `registerMissingImport is not supported in dev ${name}`,
            );
          }
          registered.push(`${name}:${id}`);
          return { id, processing: Promise.resolve() };
        },
      },
    });
    const server = {
      environments: {
        ssr: makeEnvironment("ssr"),
        // Vite's no-discovery ("explicit") optimizer throws by design.
        prerender: makeEnvironment("prerender", {
          noDiscovery: true,
          throws: true,
        }),
        // Skipped environments must not be touched even if their optimizer
        // looks usable.
        astro: makeEnvironment("astro", { throws: true }),
        client: makeEnvironment("client", { throws: true }),
        // Environments without an optimizer are skipped.
        bare: {
          name: "bare",
          config: { optimizeDeps: {} },
          depsOptimizer: undefined,
        },
      },
    };

    await expect(
      configureServer.call(plugin as never, server as never),
    ).resolves.not.toThrow();
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.every((entry) => entry.startsWith("ssr:"))).toBe(true);
  });

  it("skips the dependency optimizer in resolveId when discovery is disabled", async () => {
    const plugin = nodejsUnenvPlugin.vite(options);
    assert(plugin, "plugin is not defined");
    const hook = plugin.resolveId;
    assert(
      hook && typeof hook === "object" && "handler" in hook,
      "resolveId is not a hook",
    );
    const registerMissingImport = vi.fn(() => {
      throw new Error(
        "registerMissingImport is not supported in dev prerender",
      );
    });
    const resolve = vi.fn(async (id: string) => ({ id }));
    const context = {
      environment: {
        mode: "dev",
        config: { optimizeDeps: { noDiscovery: true } },
        depsOptimizer: { registerMissingImport },
      },
      resolve,
    };
    // `node:child_process` is polyfilled by unenv (workerd cannot spawn
    // processes), so the plugin resolves it rather than externalizing it.
    await (
      hook.handler as unknown as (
        this: typeof context,
        source: string,
        importer: string | undefined,
        options: object,
      ) => Promise<unknown>
    ).call(context, "node:child_process", undefined, {});
    expect(registerMissingImport).not.toHaveBeenCalled();
    // Falls back to resolving the polyfill directly instead of pre-bundling it.
    expect(resolve).toHaveBeenCalledTimes(1);
    const [resolvedPath] = resolve.mock.calls[0] ?? [];
    expect(resolvedPath).not.toBe("node:child_process");
  });
});
