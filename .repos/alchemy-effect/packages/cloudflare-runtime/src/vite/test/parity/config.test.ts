import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { cloudflare as officialCloudflare } from "@cloudflare/vite-plugin";
import * as vite from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import cloudflareVitePlugin from "../../plugin.ts";
import { AHEAD_OF_RELEASE_BUILT_IN_MODULES } from "./ahead-of-release.ts";

// Differential conformance: the same project resolved with
// `@cloudflare/vite-plugin` and with Alchemy's plugin must look the same to
// the frameworks and plugins that read the resolved Vite config.

const COMPATIBILITY_DATE = "2026-03-17";

let root: string;

beforeAll(async () => {
  root = await NodeFs.realpath(
    await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "alchemy-vite-parity-")),
  );
  await NodeFs.mkdir(NodePath.join(root, "src"));
  await NodeFs.writeFile(
    NodePath.join(root, "src/index.ts"),
    "export default { fetch: () => new Response('ok') };",
  );
  await NodeFs.writeFile(NodePath.join(root, "package.json"), JSON.stringify({ type: "module" }));
});

afterAll(async () => {
  await NodeFs.rm(root, { recursive: true, force: true });
});

const resolve = (
  plugins: vite.PluginOption,
  command: "serve" | "build",
  userConfig: vite.InlineConfig = {},
) =>
  vite.resolveConfig(
    { ...userConfig, configFile: false, root, logLevel: "silent", plugins: [plugins] },
    command,
  );

const official = (flags: Array<string>) =>
  officialCloudflare({
    viteEnvironment: { name: "ssr" },
    inspectorPort: false,
    persistState: false,
    config: {
      name: "worker",
      main: "./src/index.ts",
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: flags,
    },
  });

const alchemy = (flags: Array<string>) =>
  cloudflareVitePlugin({
    main: "./src/index.ts",
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: flags,
  });

// Built-ins ported ahead of the installed release are left out on both sides.
const sorted = (values: ReadonlyArray<unknown> | undefined) =>
  [...(values ?? [])]
    .map((value) => String(value))
    .filter((value) => !AHEAD_OF_RELEASE_BUILT_IN_MODULES.includes(value))
    .sort();

/** What a framework can observe of a Worker environment's resolved options. */
const workerEnvironment = (config: vite.ResolvedConfig) => {
  const environment = config.environments.ssr!;
  const build = environment.build;
  const rolldown = build.rolldownOptions ?? {};
  const optimizeDeps = environment.optimizeDeps;
  const optimizeRolldown = (optimizeDeps.rolldownOptions ?? {}) as {
    platform?: string;
    resolve?: { conditionNames?: Array<string>; extensions?: Array<string> };
    transform?: { target?: unknown; define?: Record<string, string> };
  };
  return {
    resolve: {
      conditions: environment.resolve.conditions,
      noExternal: environment.resolve.noExternal,
      builtins: sorted(environment.resolve.builtins),
      external: environment.resolve.external,
    },
    define: environment.define,
    keepProcessEnv: environment.keepProcessEnv,
    build: {
      target: build.target,
      cssTarget: build.cssTarget,
      emitAssets: build.emitAssets,
      manifest: build.manifest,
      outDir: build.outDir,
      sourcemap: build.sourcemap,
      copyPublicDir: build.copyPublicDir,
      ssr: build.ssr,
      inputNames: Object.keys((rolldown.input as Record<string, string> | undefined) ?? {}),
      preserveEntrySignatures: rolldown.preserveEntrySignatures,
      platform: rolldown.platform,
      extensions: rolldown.resolve?.extensions,
    },
    optimizeDeps: {
      noDiscovery: optimizeDeps.noDiscovery,
      ignoreOutdatedRequests: optimizeDeps.ignoreOutdatedRequests,
      exclude: sorted(optimizeDeps.exclude),
      platform: optimizeRolldown.platform,
      conditionNames: optimizeRolldown.resolve?.conditionNames,
      extensions: optimizeRolldown.resolve?.extensions,
      target: optimizeRolldown.transform?.target,
      define: optimizeRolldown.transform?.define,
    },
  };
};

const clientEnvironment = (config: vite.ResolvedConfig) => ({
  outDir: config.environments.client!.build.outDir,
  exclude: sorted(config.environments.client!.optimizeDeps.exclude),
});

describe.each([
  { name: "without nodejs_compat", flags: [] },
  { name: "with nodejs_compat", flags: ["nodejs_compat"] },
  { name: "with nodejs_als", flags: ["nodejs_als"] },
])("resolved config matches @cloudflare/vite-plugin $name", ({ flags }) => {
  it.each(["serve", "build"] as const)("%s: the Worker environment", async (command) => {
    const expected = workerEnvironment(await resolve(official(flags), command));
    const actual = workerEnvironment(await resolve(alchemy(flags), command));
    expect(actual).toEqual(expected);
  });

  it.each(["serve", "build"] as const)("%s: the client environment", async (command) => {
    const expected = clientEnvironment(await resolve(official(flags), command));
    const actual = clientEnvironment(await resolve(alchemy(flags), command));
    expect(actual).toEqual(expected);
  });

  it.each(["serve", "build"] as const)("%s: app type and denied files", async (command) => {
    const expected = await resolve(official(flags), command);
    const actual = await resolve(alchemy(flags), command);
    expect(actual.appType).toBe(expected.appType);
    // Alchemy also denies its own state and stack files.
    expect(actual.server.fs.deny).toEqual(expect.arrayContaining(expected.server.fs.deny));
  });
});

describe.each([
  { name: "a custom build.outDir", userConfig: { build: { outDir: "out" } } },
  { name: "source maps turned off", userConfig: { build: { sourcemap: false } } },
  {
    name: "the Worker's own source map setting",
    userConfig: { environments: { ssr: { build: { sourcemap: "hidden" as const } } } },
  },
])("resolved config matches @cloudflare/vite-plugin with $name", ({ userConfig }) => {
  it.each(["serve", "build"] as const)("%s", async (command) => {
    const expected = await resolve(official(["nodejs_compat"]), command, userConfig);
    const actual = await resolve(alchemy(["nodejs_compat"]), command, userConfig);
    expect(workerEnvironment(actual)).toEqual(workerEnvironment(expected));
    expect(clientEnvironment(actual)).toEqual(clientEnvironment(expected));
  });
});

describe("resolved config matches @cloudflare/vite-plugin in production", () => {
  it("defines the production NODE_ENV", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const expected = workerEnvironment(await resolve(official(["nodejs_compat"]), "build"));
      const actual = workerEnvironment(await resolve(alchemy(["nodejs_compat"]), "build"));
      expect(actual.define).toEqual(expected.define);
      expect(actual.optimizeDeps.define).toEqual(expected.optimizeDeps.define);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
