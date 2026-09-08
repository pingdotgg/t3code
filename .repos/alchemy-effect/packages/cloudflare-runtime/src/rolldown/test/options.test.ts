import path from "node:path";
import type { MinimalPluginContext } from "rolldown";
import type * as vite from "vite";
import { assert, describe, expect, it } from "vitest";
import { optionsPlugin } from "../plugins/options.ts";

const callViteConfig = async (
  plugin: vite.Plugin | null,
  userConfig: vite.UserConfig,
): Promise<vite.UserConfig> => {
  assert(plugin, "plugin is not defined");
  const hook = plugin.config;
  assert(typeof hook === "function", "plugin.config is not a function");
  const result = await hook.call({ meta: {} } as never, userConfig, {
    command: "build",
    mode: "production",
  } as never);
  assert(result, "config hook returned nothing");
  return result as vite.UserConfig;
};

const NO_HTML_ROOT = path.resolve("test/fixtures");
const HTML_ROOT = path.resolve("test/fixtures/client-html");

interface FakeEnvironment {
  name: string;
  isBuilt?: boolean;
  /** Defaults to a directory with no `index.html`. */
  root?: string;
  build?: {
    rollupOptions?: { input?: unknown };
    rolldownOptions?: { input?: unknown };
  };
}

/** Records the environments the resolved `buildApp` actually builds. */
const runBuildApp = async (
  config: vite.UserConfig,
  environments: Array<FakeEnvironment>,
): Promise<Array<string>> => {
  const buildApp = config.builder?.buildApp;
  assert(typeof buildApp === "function", "buildApp is not a function");
  const built: Array<string> = [];
  await buildApp({
    environments: Object.fromEntries(
      environments.map(
        ({ name, isBuilt = false, root = NO_HTML_ROOT, build = {} }) => [
          name,
          { name, isBuilt, config: { root, build } },
        ],
      ),
    ),
    build: async (environment: { name: string }) => {
      built.push(environment.name);
    },
  } as never);
  return built;
};

describe("options plugin", () => {
  it("applies the Cloudflare defaults", () => {
    const plugin = optionsPlugin.rolldown({});
    const input = {};
    assert(
      typeof plugin.options === "function",
      "plugin.options is not a function",
    );
    const output = plugin.options.call({} as MinimalPluginContext, input);
    assert(output, "output is not defined");
    assert(!(output instanceof Promise), "output is a promise");

    expect(output.platform).toBe("neutral");
    expect(output.resolve?.conditionNames).toEqual([
      "workerd",
      "worker",
      "module",
      "browser",
      "production",
    ]);
    expect(output.resolve?.mainFields).toEqual([
      "browser",
      "module",
      "jsnext:main",
      "jsnext",
      "main",
    ]);
    expect(output.resolve?.extensions).toEqual([
      ".mjs",
      ".js",
      ".mts",
      ".ts",
      ".jsx",
      ".tsx",
      ".json",
      ".cjs",
      ".cts",
      ".ctx",
    ]);
    expect(output.transform?.target).toBe("es2024");
  });

  it("defines production node env values and stubs process.env without nodejs_compat", () => {
    const plugin = optionsPlugin.rolldown({});
    const input = {};
    assert(
      typeof plugin.options === "function",
      "plugin.options is not a function",
    );
    const output = plugin.options!.call({} as MinimalPluginContext, input);
    assert(output, "output is not defined");
    assert(!(output instanceof Promise), "output is a promise");

    expect(output.transform?.define).toMatchObject({
      "process.env.NODE_ENV": '"production"',
      "global.process.env.NODE_ENV": '"production"',
      "globalThis.process.env.NODE_ENV": '"production"',
      "process.env": "{}",
      "global.process.env": "{}",
      "globalThis.process.env": "{}",
    });
  });

  it("does not stub process.env with nodejs_compat enabled", () => {
    const plugin = optionsPlugin.rolldown({
      compatibilityFlags: ["nodejs_compat"],
    });
    const input = {};
    assert(
      typeof plugin.options === "function",
      "plugin.options is not a function",
    );
    const output = plugin.options!.call({} as MinimalPluginContext, input);
    assert(output, "output is not defined");
    assert(!(output instanceof Promise), "output is a promise");

    expect(output.transform?.define).toMatchObject({
      "process.env.NODE_ENV": '"production"',
      "global.process.env.NODE_ENV": '"production"',
      "globalThis.process.env.NODE_ENV": '"production"',
    });
    expect(output.transform?.define?.["process.env"]).toBeUndefined();
    expect(output.transform?.define?.["global.process.env"]).toBeUndefined();
    expect(
      output.transform?.define?.["globalThis.process.env"],
    ).toBeUndefined();
  });

  it("defines navigator.userAgent only when the compatibility date supports it", () => {
    const withNavigator = optionsPlugin.rolldown({
      compatibilityDate: "2022-03-21",
    });
    const withoutNavigator = optionsPlugin.rolldown({
      compatibilityDate: "2022-03-20",
    });

    assert(
      typeof withNavigator.options === "function",
      "withNavigator.options is not a function",
    );
    assert(
      typeof withoutNavigator.options === "function",
      "withoutNavigator.options is not a function",
    );

    const withNavigatorOutput = withNavigator.options!.call(
      {} as MinimalPluginContext,
      {},
    );
    const withoutNavigatorOutput = withoutNavigator.options.call(
      {} as MinimalPluginContext,
      {},
    );

    assert(withNavigatorOutput, "withNavigatorOutput is not defined");
    assert(
      !(withNavigatorOutput instanceof Promise),
      "withNavigatorOutput is a promise",
    );
    assert(withoutNavigatorOutput, "withoutNavigatorOutput is not defined");
    assert(
      !(withoutNavigatorOutput instanceof Promise),
      "withoutNavigatorOutput is a promise",
    );

    expect(withNavigatorOutput.transform?.define?.["navigator.userAgent"]).toBe(
      '"Cloudflare-Workers"',
    );
    expect(
      withoutNavigatorOutput.transform?.define?.["navigator.userAgent"],
    ).toBeUndefined();
  });

  it("normalizes Windows backslashes in worker entry ids", () => {
    const plugin = optionsPlugin.rolldown({});
    assert(
      typeof plugin.options === "function",
      "plugin.options is not a function",
    );
    const output = plugin.options.call({} as MinimalPluginContext, {
      input: { worker: "D:\\src\\app\\entry-server.ts" },
    });
    assert(output, "output is not defined");
    assert(!(output instanceof Promise), "output is a promise");

    // The virtual worker-entry id must use POSIX separators so it round-trips
    // through Rolldown/Vite id handling and resolves on Windows.
    expect(output.input).toEqual({
      worker: "\0distilled:worker-entry:D:/src/app/entry-server.ts",
    });
  });

  it("defaults builder.buildApp when the user config does not define one", async () => {
    const plugin = optionsPlugin.vite({ main: "./worker.ts" });
    const result = await callViteConfig(plugin, {});
    expect(typeof result.builder?.buildApp).toBe("function");
  });

  it("does not clobber a framework-provided builder.buildApp", async () => {
    // Vite merges plugin `config` results over the user config, so returning a
    // default here would replace the framework's orchestrator (e.g. Astro's
    // prerender -> ssr -> client pipeline).
    const buildApp = async () => {};
    const plugin = optionsPlugin.vite({ main: "./worker.ts" });
    const result = await callViteConfig(plugin, { builder: { buildApp } });
    expect(result.builder).toBeUndefined();
  });

  it("does not provide a builder in SPA mode", async () => {
    const plugin = optionsPlugin.vite({});
    const result = await callViteConfig(plugin, {});
    expect(result.appType).toBe("spa");
    expect(result.builder).toBeUndefined();
  });

  it("skips skipEnvironments in the default buildApp", async () => {
    const plugin = optionsPlugin.vite({
      main: "./worker.ts",
      skipEnvironments: ["prerender"],
    });
    const result = await callViteConfig(plugin, {});

    const built = await runBuildApp(result, [
      { name: "ssr" },
      { name: "client", build: { rollupOptions: { input: "./src/main.tsx" } } },
      // Framework-owned environment with no build input of its own.
      { name: "prerender" },
      { name: "already", isBuilt: true },
    ]);
    expect(built).toEqual(["ssr", "client"]);
  });

  it("skips the entry-less client environment in the default buildApp", async () => {
    // Vite creates `client` for every app. A pure Worker app never configures
    // it, so building it would fall back to a nonexistent `index.html`.
    const plugin = optionsPlugin.vite({ main: "./worker.ts" });
    const result = await callViteConfig(plugin, {});

    const built = await runBuildApp(result, [
      { name: "ssr" },
      { name: "client" },
    ]);
    expect(built).toEqual(["ssr"]);
  });

  it("builds a client environment that has a configured input", async () => {
    const plugin = optionsPlugin.vite({ main: "./worker.ts" });
    const result = await callViteConfig(plugin, {});

    const withRollupInput = await runBuildApp(result, [
      { name: "client", build: { rollupOptions: { input: "./src/main.tsx" } } },
    ]);
    expect(withRollupInput).toEqual(["client"]);

    const withRolldownInput = await runBuildApp(result, [
      {
        name: "client",
        build: { rolldownOptions: { input: "./src/main.tsx" } },
      },
    ]);
    expect(withRolldownInput).toEqual(["client"]);
  });

  it("builds a client environment whose root has an index.html", async () => {
    const plugin = optionsPlugin.vite({ main: "./worker.ts" });
    const result = await callViteConfig(plugin, {});

    const built = await runBuildApp(result, [
      { name: "client", root: HTML_ROOT },
    ]);
    expect(built).toEqual(["client"]);
  });
});
