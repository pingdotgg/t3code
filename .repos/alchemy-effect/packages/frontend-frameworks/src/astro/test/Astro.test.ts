import { Framework, type BuildOutput } from "../../core/index.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AstroIntegration } from "astro";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import type * as ViteModule from "vite";
import { describe, expect, it } from "vitest";
import cloudflareTarget, {
  distilledCloudflare,
  IMAGE_PASSTHROUGH_ENDPOINT,
  makeIntegrationPluginOptions,
  SERVER_ENTRYPOINT,
} from "../cloudflare.ts";
import { createConfigPlugin } from "../config-plugin.ts";
import framework, {
  DEFAULT_TARGET_SPECIFIER,
  isAstroTarget,
  layer as toLayer,
  makeAstroInlineConfig,
  NODE_ENVIRONMENTS,
  type AstroTarget,
} from "../index.ts";

const ROOT = "/project";

const TEST_ADAPTER: AstroIntegration = { name: "test-adapter", hooks: {} };

const flatten = (plugins: unknown): Array<ViteModule.Plugin> =>
  ((plugins ?? []) as Array<unknown>)
    .flat(Infinity)
    .filter(
      (plugin): plugin is ViteModule.Plugin =>
        typeof plugin === "object" && plugin !== null && "name" in plugin,
    );

type CapturedConfig = {
  build?: { redirects?: boolean };
  vite?: { plugins?: unknown };
  image?: {
    service?: { entrypoint?: string | URL };
    endpoint?: { entrypoint?: string | URL };
  };
};

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const runConfigSetup = (
  integration: AstroIntegration,
  command: "dev" | "build" | "sync",
): CapturedConfig => {
  let captured: CapturedConfig | undefined;
  const hook = integration.hooks["astro:config:setup"];
  if (!hook) throw new Error("astro:config:setup hook missing");
  void hook({
    command,
    config: { vite: {}, image: {} },
    updateConfig: (config: unknown) => {
      captured = config as CapturedConfig;
      return {} as never;
    },
    logger: noopLogger,
  } as never);
  if (!captured) throw new Error("updateConfig was not called");
  return captured;
};

const objectHook = <A extends Array<unknown>, R>(
  hook: unknown,
): ((this: unknown, ...args: A) => R) => {
  if (typeof hook === "function") return hook as never;
  if (typeof hook === "object" && hook !== null && "handler" in hook) {
    return (hook as { handler: (this: unknown, ...args: A) => R }).handler;
  }
  throw new Error("hook is neither a function nor an object hook");
};

describe("cloudflare target module", () => {
  it("default-exports a factory producing an AstroTarget for the cloudflare platform", () => {
    const target = cloudflareTarget({});
    expect(target.platform).toBe("cloudflare");
    expect(isAstroTarget(target)).toBe(true);
    expect(target.bundle?.conditions).toEqual([
      "workerd",
      "worker",
      "module",
      "browser",
    ]);
    expect(target.bundle?.external).toEqual(["cloudflare:"]);
    expect(target.build).toBeUndefined();
    expect(target.serve).toBeUndefined();
  });

  it("carries the config opaquely and builds the forked integration from it", () => {
    const worker = { compatibilityDate: "2026-03-10" };
    const target = cloudflareTarget({
      worker,
      prerenderEnvironment: "node",
      sessionKVBindingName: "MY_SESSION",
    });
    expect(target.config).toEqual({
      worker,
      prerenderEnvironment: "node",
      sessionKVBindingName: "MY_SESSION",
    });
    const integration = target.integration();
    expect(integration.name).toBe("@alchemy.run/frontend-frameworks/astro");
    expect(integration.hooks["astro:config:setup"]).toBeDefined();
  });

  it("is the default target specifier of the framework module", () => {
    expect(DEFAULT_TARGET_SPECIFIER).toBe(
      "@alchemy.run/frontend-frameworks/astro/cloudflare",
    );
  });
});

describe("isAstroTarget", () => {
  it("accepts a DeployTarget with an integration hook and rejects others", () => {
    expect(isAstroTarget(cloudflareTarget())).toBe(true);
    expect(isAstroTarget({ platform: "cloudflare", config: {} })).toBe(false);
    expect(isAstroTarget(undefined)).toBe(false);
    expect(isAstroTarget("cloudflare")).toBe(false);
  });
});

describe("makeIntegrationPluginOptions", () => {
  it("pins main, the ssr entry environment, and the node skipEnvironments", () => {
    const options = makeIntegrationPluginOptions();
    expect(options.main).toBe(SERVER_ENTRYPOINT);
    expect(options.viteEnvironments).toEqual({ entry: "ssr" });
    expect(options.skipEnvironments).toEqual([...NODE_ENVIRONMENTS]);
  });

  it("preserves user cloudflare options but overrides the structural ones", () => {
    const options = makeIntegrationPluginOptions({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      worker: { name: "fixtures-astro", bindings: [] },
      main: "/somewhere/else.ts",
      viteEnvironments: { entry: "rsc" },
      skipEnvironments: ["custom", "prerender"],
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
    expect(options.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(options.worker?.name).toBe("fixtures-astro");
    // Astro-structural options always win: the worker entry is the vendored
    // server entrypoint and Astro pins the worker environment name to "ssr".
    expect(options.main).toBe(SERVER_ENTRYPOINT);
    expect(options.viteEnvironments).toEqual({ entry: "ssr" });
    expect(options.skipEnvironments).toEqual(["astro", "prerender", "custom"]);
  });
});

describe("makeAstroInlineConfig", () => {
  it("pins root, leaves configFile undiscovered-default, injects the target integration; leaves output unset", () => {
    const config = makeAstroInlineConfig({
      root: ROOT,
      integration: TEST_ADAPTER,
    });
    expect(config.root).toBe(ROOT);
    // The user's astro.config.* must load natively: configFile stays
    // undefined so astro's own discovery runs (and degrades gracefully to
    // no file — the internal programmatic fallback).
    expect(config.configFile).toBeUndefined();
    // The inline config merges OVER the config file, so a default `output`
    // here would clobber the file's (e.g. an explicit "static"). It must
    // only appear when passed explicitly via the user overrides.
    expect("output" in config).toBe(false);
    // The target integration rides in `integrations` (it self-registers as
    // the adapter at astro:config:done), never in `adapter` — an inline
    // `adapter` would deep-merge with a user-file adapter object.
    expect(config.adapter).toBeUndefined();
    expect(
      (config.integrations as Array<AstroIntegration>).map((i) => i.name),
    ).toEqual(["test-adapter"]);
  });

  it("merges user config, appends the target integration after the user's", () => {
    const userIntegration: AstroIntegration = {
      name: "user-integration",
      hooks: {},
    };
    const config = makeAstroInlineConfig({
      root: ROOT,
      integration: TEST_ADAPTER,
      userConfig: {
        site: "https://example.com",
        output: "static",
        root: "/elsewhere",
        integrations: [userIntegration],
        devToolbar: { enabled: false },
      },
    });
    expect(config.site).toBe("https://example.com");
    expect(config.output).toBe("static");
    expect(config.devToolbar).toEqual({ enabled: false });
    expect(config.root).toBe(ROOT);
    expect(config.configFile).toBeUndefined();
    expect(
      (config.integrations as Array<AstroIntegration>).map((i) => i.name),
    ).toEqual(["user-integration", "test-adapter"]);
  });

  it("lets a user-supplied adapter flow through so astro:config:done rejects it with the actionable error", () => {
    const config = makeAstroInlineConfig({
      root: ROOT,
      integration: TEST_ADAPTER,
      userConfig: { adapter: { name: "user-adapter", hooks: {} } },
    });
    expect((config.adapter as AstroIntegration).name).toBe("user-adapter");
  });

  it("merges the dev port into server options", () => {
    const config = makeAstroInlineConfig({
      root: ROOT,
      integration: TEST_ADAPTER,
      userConfig: { server: { host: "127.0.0.1" } },
      port: 3102,
    });
    expect(config.server).toEqual({ host: "127.0.0.1", port: 3102 });
  });

  it("appends extra vite plugins after the user's", () => {
    const userPlugin: ViteModule.Plugin = { name: "user-plugin" };
    const collectorPlugin: ViteModule.Plugin = { name: "alchemy:build-output" };
    const config = makeAstroInlineConfig({
      root: ROOT,
      integration: TEST_ADAPTER,
      userConfig: { vite: { plugins: [userPlugin] } },
      extraVitePlugins: [collectorPlugin],
    });
    const plugins = flatten(config.vite?.plugins);
    const names = plugins.map((plugin) => plugin.name);
    expect(names.indexOf("user-plugin")).toBeLessThan(
      names.indexOf("alchemy:build-output"),
    );
  });
});

describe("distilledCloudflare astro:config:setup", () => {
  it("injects the cloudflare plugins, config plugin, and prerender plugins in dev", () => {
    // Default (workerd) prerendering: no node dev middleware, the workerd
    // prerender environment plugin instead.
    const workerdNames = flatten(
      runConfigSetup(distilledCloudflare(), "dev").vite?.plugins,
    ).map((plugin) => plugin.name);
    expect(workerdNames).toContain(
      "@alchemy.run/frontend-frameworks/astro:workerd-prerender-environment",
    );
    expect(workerdNames).not.toContain(
      "@alchemy.run/frontend-frameworks/astro:dev-server-prerender-middleware",
    );

    const captured = runConfigSetup(
      distilledCloudflare({ prerenderEnvironment: "node" }),
      "dev",
    );
    const plugins = flatten(captured.vite?.plugins);
    const names = plugins.map((plugin) => plugin.name);
    expect(names).toContain(
      "@alchemy.run/frontend-frameworks/astro:dev-server-prerender-middleware",
    );
    expect(names).toContain(
      "@alchemy.run/frontend-frameworks/astro:cf-imports",
    );
    expect(names).toContain(
      "@alchemy.run/frontend-frameworks/astro:environment",
    );
    expect(names).toContain(
      "@alchemy.run/frontend-frameworks/astro:cf-externals",
    );
    expect(names).toContain("virtual:astro-cloudflare:config");
    const cloudflare = plugins.filter((plugin) =>
      plugin.name.startsWith("distilled-cloudflare"),
    );
    expect(cloudflare.length).toBeGreaterThan(0);
    // Dev keeps the dev server hooks intact.
    expect(
      cloudflare.some((plugin) => plugin.configureServer !== undefined),
    ).toBe(true);
    expect(captured.build?.redirects).toBe(false);
  });

  it("strips configureServer from the cloudflare plugins during build/sync typegen", () => {
    for (const command of ["build", "sync"] as const) {
      const captured = runConfigSetup(distilledCloudflare(), command);
      const plugins = flatten(captured.vite?.plugins);
      const names = plugins.map((plugin) => plugin.name);
      expect(names).not.toContain(
        "@alchemy.run/frontend-frameworks/astro:dev-server-prerender-middleware",
      );
      const cloudflare = plugins.filter((plugin) =>
        plugin.name.startsWith("distilled-cloudflare"),
      );
      expect(cloudflare.length).toBeGreaterThan(0);
      expect(
        cloudflare.every((plugin) => plugin.configureServer === undefined),
      ).toBe(true);
    }
  });

  it("configures the passthrough image service with the phase-specific endpoint", () => {
    const dev = runConfigSetup(distilledCloudflare(), "dev");
    expect(dev.image?.service?.entrypoint).toBeDefined();
    expect(dev.image?.endpoint).toEqual({
      entrypoint: "astro/assets/endpoint/generic",
    });
    const build = runConfigSetup(distilledCloudflare(), "build");
    expect(build.image?.endpoint).toEqual({
      entrypoint: IMAGE_PASSTHROUGH_ENDPOINT,
    });
  });

  it("pre-bundles the server environments in dev but disables discovery during typegen", () => {
    const findEnvironmentPlugin = (command: "dev" | "build") => {
      const captured = runConfigSetup(distilledCloudflare(), command);
      const plugin = flatten(captured.vite?.plugins).find(
        (candidate) =>
          candidate.name ===
          "@alchemy.run/frontend-frameworks/astro:environment",
      );
      if (!plugin) throw new Error("environment plugin missing");
      return objectHook<
        [string, ViteModule.EnvironmentOptions],
        { optimizeDeps?: ViteModule.DepOptimizationOptions } | undefined
      >(plugin.configEnvironment);
    };

    const dev = findEnvironmentPlugin("dev");
    expect(dev.call({}, "ssr", {})?.optimizeDeps?.include).toContain(
      SERVER_ENTRYPOINT,
    );
    expect(dev.call({}, "client", {})?.optimizeDeps?.include).toContain(
      "astro/runtime/client/dev-toolbar/entrypoint.js",
    );
    expect(dev.call({}, "custom", {})).toBeUndefined();
    // Environments already configured with an explicit (no-discovery)
    // optimizer are left alone.
    expect(
      dev.call({}, "ssr", { optimizeDeps: { noDiscovery: true } }),
    ).toBeUndefined();

    const typegen = findEnvironmentPlugin("build");
    expect(typegen.call({}, "ssr", {})?.optimizeDeps).toEqual({
      noDiscovery: true,
      include: [],
    });
  });

  it("scopes cf-externals to the worker-resolved server environments", () => {
    const captured = runConfigSetup(distilledCloudflare(), "build");
    const plugin = flatten(captured.vite?.plugins).find(
      (candidate) =>
        candidate.name ===
        "@alchemy.run/frontend-frameworks/astro:cf-externals",
    );
    if (!plugin) throw new Error("cf-externals plugin missing");
    const applies = plugin.applyToEnvironment as (environment: {
      name: string;
    }) => boolean;
    expect(applies({ name: "ssr" })).toBe(true);
    expect(applies({ name: "prerender" })).toBe(true);
    expect(applies({ name: "client" })).toBe(false);
    const config = objectHook<[{ ssr?: { external?: unknown } }], void>(
      plugin.config,
    );
    const conf = { ssr: { external: ["some-dep"] } };
    config.call({}, conf);
    expect(conf.ssr.external).toBeUndefined();
  });
});

describe("distilledCloudflare astro:config:done", () => {
  it("registers the adapter without a preview entrypoint", () => {
    let adapter: Record<string, unknown> | undefined;
    const integration = distilledCloudflare();
    const hook = integration.hooks["astro:config:done"];
    if (!hook) throw new Error("astro:config:done hook missing");
    void hook({
      buildOutput: "server",
      config: {
        base: "/",
        build: { client: new URL("file:///project/dist/client/") },
      },
      injectTypes: () => new URL("file:///dev/null"),
      setAdapter: (value: unknown) => {
        adapter = value as Record<string, unknown>;
      },
    } as never);
    expect(adapter?.name).toBe("@alchemy.run/frontend-frameworks/astro");
    expect(adapter?.previewEntrypoint).toBeUndefined();
    expect(adapter?.serverEntrypoint).toBeUndefined();
    expect(adapter?.adapterFeatures).toMatchObject({
      buildOutput: "server",
      middlewareMode: "classic",
      preserveBuildClientDir: true,
      preserveBuildServerDir: true,
    });
  });

  it("injects a hookless adapter marker at astro:config:setup when the config declares none", () => {
    // Astro's build refuses server output unless `config.adapter` is set;
    // the integration (injected via `integrations`) satisfies the check
    // with an inert marker while `setAdapter` registers the real adapter.
    const integration = distilledCloudflare();
    const updates: Array<Record<string, unknown>> = [];
    const hook = integration.hooks["astro:config:setup"];
    if (!hook) throw new Error("astro:config:setup hook missing");
    void hook({
      command: "build",
      config: { vite: {}, image: {} },
      updateConfig: (update: unknown) => {
        updates.push(update as Record<string, unknown>);
        return {} as never;
      },
      logger: noopLogger,
    } as never);
    const marker = updates.find((update) => update.adapter !== undefined)
      ?.adapter as { name: string; hooks: Record<string, unknown> } | undefined;
    expect(marker).toEqual({
      name: "@alchemy.run/frontend-frameworks/astro",
      hooks: {},
    });
    // With the marker injected, astro:config:done registers the adapter.
    const done = integration.hooks["astro:config:done"];
    if (!done) throw new Error("astro:config:done hook missing");
    let adapter: Record<string, unknown> | undefined;
    void done({
      buildOutput: "server",
      config: {
        base: "/",
        adapter: marker,
        build: { client: new URL("file:///project/dist/client/") },
      },
      injectTypes: () => new URL("file:///dev/null"),
      setAdapter: (value: unknown) => {
        adapter = value as Record<string, unknown>;
      },
    } as never);
    expect(adapter?.name).toBe("@alchemy.run/frontend-frameworks/astro");
  });

  it("does not inject the marker when the config declares an adapter, and fails at astro:config:done", () => {
    const integration = distilledCloudflare();
    const updates: Array<Record<string, unknown>> = [];
    const setup = integration.hooks["astro:config:setup"];
    if (!setup) throw new Error("astro:config:setup hook missing");
    void setup({
      command: "build",
      config: {
        vite: {},
        image: {},
        adapter: { name: "@astrojs/cloudflare", hooks: {} },
      },
      updateConfig: (update: unknown) => {
        updates.push(update as Record<string, unknown>);
        return {} as never;
      },
      logger: noopLogger,
    } as never);
    expect(updates.every((update) => update.adapter === undefined)).toBe(true);
    const done = integration.hooks["astro:config:done"];
    if (!done) throw new Error("astro:config:done hook missing");
    expect(() =>
      done({
        buildOutput: "server",
        config: {
          base: "/",
          adapter: { name: "@astrojs/cloudflare", hooks: {} },
          build: { client: new URL("file:///project/dist/client/") },
        },
        injectTypes: () => new URL("file:///dev/null"),
        setAdapter: () => {},
      } as never),
    ).toThrow(
      /declares the adapter "@astrojs\/cloudflare"[\s\S]*Remove `adapter`/,
    );
  });
});

describe("distilledCloudflare astro:build:setup", () => {
  it("applies the server-target vite tweaks", () => {
    const integration = distilledCloudflare();
    const hook = integration.hooks["astro:build:setup"];
    if (!hook) throw new Error("astro:build:setup hook missing");
    const viteConfig: Record<string, any> = {};
    void hook({ vite: viteConfig, target: "server" } as never);
    expect(viteConfig.ssr?.noExternal).toBe(true);
    expect(viteConfig.build?.rolldownOptions?.external).toEqual(["sharp"]);
    expect(viteConfig.build?.rolldownOptions?.output?.banner).toContain(
      "globalThis.process",
    );
    expect(viteConfig.define?.["globalThis.__ASTRO_IMAGES_BINDING_NAME"]).toBe(
      '"IMAGES"',
    );

    const clientConfig: Record<string, any> = {};
    void hook({ vite: clientConfig, target: "client" } as never);
    expect(clientConfig.ssr).toBeUndefined();
  });
});

describe("config plugin (virtual:astro-cloudflare:config)", () => {
  const plugin = createConfigPlugin({
    sessionKVBindingName: "SESSION",
    compileImageConfig: null,
    cacheProviderEnabled: false,
  });

  it("resolves and loads the virtual module", () => {
    const resolveId = objectHook<[string], string>(plugin.resolveId);
    const resolved = resolveId.call({}, "virtual:astro-cloudflare:config");
    expect(resolved).toBe("\0virtual:astro-cloudflare:config");

    const load = objectHook<[string], string>(plugin.load);
    const code = load.call({ environment: { name: "ssr" } }, resolved);
    expect(code).toContain('export const sessionKVBindingName = "SESSION"');
    expect(code).toContain("export const compileImageConfig = null");
    expect(code).toContain("export const cacheProviderEnabled = false");
    expect(code).toContain("export const isPrerender = false");
  });

  it("marks isPrerender only in the prerender environment", () => {
    const load = objectHook<[string], string>(plugin.load);
    const code = load.call(
      { environment: { name: "prerender" } },
      "\0virtual:astro-cloudflare:config",
    );
    expect(code).toContain("export const isPrerender = true");
  });
});

describe("vendored runtime purity", () => {
  it("never imports wrangler, @astrojs/cloudflare, or @cloudflare/vite-plugin", async () => {
    const runtimeDir = NodePath.resolve(import.meta.dirname, "../runtime");
    const entries = await NodeFsPromises.readdir(runtimeDir, {
      recursive: true,
      withFileTypes: true,
    });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => NodePath.join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await NodeFsPromises.readFile(file, "utf8");
      expect(source, file).not.toMatch(/["']wrangler["']|["']wrangler\//);
      expect(source, file).not.toMatch(/["']@astrojs\/cloudflare/);
      expect(source, file).not.toMatch(/["']@cloudflare\/vite-plugin/);
    }
  });
});

describe("framework factory", () => {
  it("default-exports a factory producing a Layer<Framework>", () => {
    expect(Layer.isLayer(framework({}))).toBe(true);
    expect(Layer.isLayer(toLayer())).toBe(true);
  });

  it("accepts the harness's target-scoped carriage and the deprecated vite alias", () => {
    expect(
      Layer.isLayer(
        framework({
          target: {
            cloudflare: { worker: { compatibilityDate: "2026-03-10" } },
          },
        }),
      ),
    ).toBe(true);
    expect(
      Layer.isLayer(framework({ vite: { compatibilityDate: "2026-03-10" } })),
    ).toBe(true);
  });
});

describe("deploy-target resolution", () => {
  const OUTPUT: BuildOutput = {
    clientDirectory: undefined,
    serverModules: [
      { name: "entry.mjs", content: "export default {}", hash: "hash" },
    ],
    externalWorkspaces: new Set<string>(),
  };

  const run = <A, E>(
    layer: Layer.Layer<Framework, unknown, never>,
    effect: Effect.Effect<A, E, Framework>,
  ) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>,
    );

  const build = Effect.flatMap(Framework, (service) => service.build());

  it("delegates the build wholesale when the target defines `build`", async () => {
    const contexts: Array<{ root: string; framework?: string | undefined }> =
      [];
    const target: AstroTarget = {
      platform: "test",
      config: {},
      integration: () => TEST_ADAPTER,
      build: (context) => {
        contexts.push({ root: context.root, framework: context.framework });
        return Effect.succeed(OUTPUT);
      },
    };
    const layer = toLayer({ target }).pipe(Layer.provide(NodeServices.layer));
    const output = await run(layer, build);
    expect(output).toEqual(OUTPUT);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.framework).toBe("astro");
    expect(NodePath.isAbsolute(contexts[0]?.root ?? "")).toBe(true);
  });

  it("fails with a FrameworkError when the resolved target is not an AstroTarget", async () => {
    const layer = toLayer({
      target: { platform: "test", config: {} } as unknown as AstroTarget,
    }).pipe(Layer.provide(NodeServices.layer));
    const error = await run(layer, Effect.flip(build));
    expect(error).toMatchObject({
      _tag: "FrameworkError",
      framework: "astro",
    });
    expect(String((error as { message: string }).message)).toContain(
      "AstroTarget",
    );
  });

  it("applies a target factory to targetConfig", async () => {
    const configs: Array<unknown> = [];
    const layer = toLayer({
      target: (config: { flag: boolean }) => {
        configs.push(config);
        return {
          platform: "test",
          config,
          integration: () => TEST_ADAPTER,
          build: () => Effect.succeed(OUTPUT),
        } satisfies AstroTarget<{ flag: boolean }>;
      },
      targetConfig: { flag: true },
    }).pipe(Layer.provide(NodeServices.layer));
    const output = await run(layer, build);
    expect(output).toEqual(OUTPUT);
    expect(configs).toEqual([{ flag: true }]);
  });
});
