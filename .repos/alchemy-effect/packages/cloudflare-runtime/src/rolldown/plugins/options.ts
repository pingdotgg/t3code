import fs from "node:fs";
import path from "node:path";
import { nonPrefixedNodeModules } from "@cloudflare/unenv-preset";
import type * as vite from "vite";
import { createPlugin } from "../factory.ts";
import { parseViteEnvironments, type BasePluginOptions } from "../options.ts";
import { hasNodejsCompat } from "../utils.ts";
import { workerEntryId } from "./virtual-modules.ts";

const DEFAULT_RESOLVE_CONDITION_NAMES = ["workerd", "worker", "module", "browser"];
const DEFAULT_RESOLVE_MAIN_FIELDS = ["browser", "module", "jsnext:main", "jsnext", "main"];
const DEFAULT_RESOLVE_EXTENSIONS = [
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
];

// workerd runs `using` declarations natively, so Rolldown builds keep them.
// esbuild (Vite 6 and 7) has no `es2026`, so it gets `supported.using`.
const TARGET = "es2026";
const ESBUILD_TARGET = "es2024";
const CSS_TARGET = "es2024";
const ESBUILD_SUPPORTED = { using: true };

export interface OptionsApi {
  input: () => Record<string, string>;
}

export const optionsPlugin = createPlugin<"options", OptionsApi>("options", (pluginOptions) => {
  let input: Record<string, string> = {};
  // A framework's own `index` input in the Worker environment (Waku's server
  // entry) merges over the Worker entry's, so once every config is merged the
  // Worker entry takes `index` back and the framework's builds under its own
  // name.
  const restoreWorkerEntryInput = (config: vite.ResolvedConfig) => {
    if (typeof pluginOptions.main !== "string" || input.index === undefined) return;
    const workerEntry = workerEntryId(input.index);
    const build = config.environments[parseViteEnvironments(pluginOptions)[0]]?.build;
    for (const options of new Set([build?.rolldownOptions, build?.rollupOptions])) {
      const current = options?.input;
      if (!options || !current || typeof current !== "object" || Array.isArray(current)) continue;
      const displaced = current.index;
      if (displaced === undefined || displaced === workerEntry) continue;
      options.input = {
        ...current,
        [path.parse(displaced).name || "framework"]: displaced,
        index: workerEntry,
      };
    }
  };
  return {
    shared: {
      api: {
        input: () => input,
      },
    },
    rolldown: {
      options(options) {
        input = normalizeInput(pluginOptions.main ?? options.input ?? {});
        options.input = wrapInput(input);
        options.preserveEntrySignatures ??= "strict";
        options.platform ??= "neutral";
        options.resolve ??= {};
        options.resolve.conditionNames ??= [...DEFAULT_RESOLVE_CONDITION_NAMES, "production"];
        options.resolve.mainFields ??= DEFAULT_RESOLVE_MAIN_FIELDS;
        options.resolve.extensions ??= DEFAULT_RESOLVE_EXTENSIONS;
        options.transform ??= {};
        options.transform.target ??= TARGET;
        options.transform.define ??= {};
        Object.assign(options.transform.define, getDefine(pluginOptions, "production", "wrangler"));
        return options;
      },
    },
    vite: {
      // On Vite 6 and 7, `vite:esbuild-transpile` lowers every chunk with the
      // top-level `esbuild` options, which would also leave `using` in the
      // client bundle. Each environment reads its own `esbuild` first, so
      // the Worker environments get theirs.
      configResolved(config) {
        restoreWorkerEntryInput(config);
        if (this.meta.rolldownVersion || config.esbuild === false) return;
        const esbuild = {
          ...config.esbuild,
          supported: { ...config.esbuild.supported, ...ESBUILD_SUPPORTED },
        };
        for (const name of parseViteEnvironments(pluginOptions)) {
          const environment = config.environments[name];
          if (environment) Object.assign(environment, { esbuild });
        }
      },
      async config(userConfig) {
        const vite = await import("vite");
        const isRolldown = "rolldownVersion" in this.meta;
        const environmentNames = parseViteEnvironments(pluginOptions);
        const root = path.resolve(userConfig.root ?? ".");
        input = resolveInputPaths(
          // `main` builds as `index`, `@cloudflare/vite-plugin`'s entry chunk
          // name, which frameworks read back (RedwoodSDK links
          // `<outDir>/index.js`).
          typeof pluginOptions.main === "string"
            ? { index: pluginOptions.main }
            : normalizeInput(
                pluginOptions.main ??
                  defaultEnvironmentEntries(environmentNames[0], userConfig) ??
                  {},
              ),
          root,
        );
        const rollupOptions: vite.Rollup.RollupOptions = {
          input: wrapInput(input),
          preserveEntrySignatures: "strict",
        };
        const define = getDefine(
          pluginOptions,
          process.env.NODE_ENV || userConfig.mode || "production",
          "vite",
        );
        const makeEnvironment = ({
          name,
          isEntry,
        }: {
          name: string;
          isEntry: boolean;
        }): vite.EnvironmentOptions => {
          const entries = isEntry
            ? (pluginOptions.main ?? defaultEnvironmentEntries(name, userConfig))
            : (defaultEnvironmentEntries(name, userConfig) ?? pluginOptions.main);
          return {
            // Bake `process.env.NODE_ENV` (and friends) into the worker build.
            // workerd has no value for it at runtime, so without this libraries
            // like React fall back to their development builds. Setting `define`
            // at the environment level applies it even though `keepProcessEnv`
            // stays `true` (so other `process.env` access is preserved at
            // runtime for `nodejs_compat`).
            define,
            resolve: {
              noExternal: true,
              conditions: [...DEFAULT_RESOLVE_CONDITION_NAMES, "development|production"],
            },
            optimizeDeps: {
              noDiscovery:
                userConfig.environments?.[name]?.optimizeDeps?.noDiscovery ??
                userConfig.optimizeDeps?.noDiscovery ??
                false,
              ignoreOutdatedRequests: true,
              entries: asArray(entries)?.map(vite.normalizePath),
              // Node.js built-ins are never pre-bundled, with or without
              // `nodejs_compat` (`cloudflare:*` modules: `cloudflare-externals`).
              exclude: [
                ...nonPrefixedNodeModules,
                ...nonPrefixedNodeModules.map((module) => `node:${module}`),
                "node:sea",
                "node:sqlite",
                "node:test",
                "node:test/reporters",
              ],
              ...(isRolldown
                ? {
                    rolldownOptions: {
                      platform: "neutral",
                      resolve: {
                        conditionNames: [...DEFAULT_RESOLVE_CONDITION_NAMES, "development"],
                        mainFields: DEFAULT_RESOLVE_MAIN_FIELDS,
                        extensions: DEFAULT_RESOLVE_EXTENSIONS,
                      },
                      transform: {
                        target: TARGET,
                        define,
                      },
                    },
                  }
                : {
                    esbuildOptions: {
                      platform: "neutral",
                      conditions: [...DEFAULT_RESOLVE_CONDITION_NAMES, "development"],
                      resolveExtensions: DEFAULT_RESOLVE_EXTENSIONS,
                      mainFields: DEFAULT_RESOLVE_MAIN_FIELDS,
                      target: ESBUILD_TARGET,
                      supported: ESBUILD_SUPPORTED,
                      define,
                    },
                  }),
            },
            keepProcessEnv: true,
            // The entry environment owns the Worker's build input and server
            // output directory; children (e.g. `ssr`) keep their own build config
            // from the framework plugin (`@vitejs/plugin-rsc`).
            ...(isEntry
              ? {
                  build: {
                    ssr: true,
                    target: isRolldown ? TARGET : ESBUILD_TARGET,
                    cssTarget: CSS_TARGET,
                    emitAssets: true,
                    manifest: true,
                    // Source maps upload with the Worker, for readable stack traces.
                    sourcemap:
                      userConfig.environments?.[name]?.build?.sourcemap ??
                      userConfig.build?.sourcemap ??
                      true,
                    copyPublicDir: false,
                    outDir: getOutputDirectory(userConfig, name),
                    ...(isRolldown
                      ? {
                          rolldownOptions: {
                            ...rollupOptions,
                            platform: "neutral",
                            resolve: {
                              mainFields: DEFAULT_RESOLVE_MAIN_FIELDS,
                              extensions: DEFAULT_RESOLVE_EXTENSIONS,
                            },
                          },
                        }
                      : { rollupOptions }),
                  },
                }
              : {}),
          };
        };
        // No Worker entry: an assets-only site. Declared `viteEnvironments`
        // mean a framework plugin supplies the entry later (e.g.
        // `@vitejs/plugin-rsc` in its own `config` hook).
        const assetsOnly =
          Object.keys(input).length === 0 && pluginOptions.viteEnvironments === undefined;
        // `custom` as `@cloudflare/vite-plugin` sets it: Vite's own SPA/MPA
        // HTML middleware never answers in dev, so every request it doesn't
        // serve reaches the Worker's router, which applies the asset rules
        // (`htmlHandling`, `notFoundHandling`, `runWorkerFirst`).
        const appType = userConfig.appType ?? "custom";
        return {
          appType,
          builder:
            // Vite merges plugin `config` results over the user config, so an
            // unconditional default here would clobber a framework's own
            // `buildApp` orchestrator (e.g. Astro's prerender -> ssr -> client
            // pipeline). Only default it when the resolved user config doesn't
            // already define one.
            userConfig.builder?.buildApp !== undefined
              ? undefined
              : {
                  buildApp: (builder) =>
                    // An assets-only site builds only its client.
                    buildApp(builder, assetsOnly ? [] : environmentNames, pluginOptions),
                },
          // An assets-only site has no Worker environments, as with
          // `@cloudflare/vite-plugin`: the client builds to Vite's own outDir.
          environments: assetsOnly
            ? undefined
            : {
                client: {
                  build: {
                    outDir: getOutputDirectory(userConfig, "client"),
                  },
                },
                ...Object.fromEntries(
                  environmentNames.map((name, index) => [
                    name,
                    makeEnvironment({ name, isEntry: index === 0 }),
                  ]),
                ),
              },
        };
      },
    },
  };
});

export const CLIENT_FALLBACK_ENTRY_ID = "virtual:cloudflare/client-fallback-entry";
const CLIENT_FALLBACK_ENTRY_NAME = "__cloudflare_fallback_entry__";

/**
 * `@cloudflare/vite-plugin`'s default build: the Worker environments, any
 * other environment the app declares, then the client. A client with no
 * entry still builds when it has `public/` files or the Worker imports
 * assets, so its output holds every static asset; the Worker's imported
 * assets then move into it.
 */
const buildApp = async (
  builder: vite.ViteBuilder,
  environmentNames: ReadonlyArray<string>,
  options: BasePluginOptions,
) => {
  const client = builder.environments.client;
  const workerEnvironments = environmentNames.flatMap((name) => {
    const environment = builder.environments[name];
    return environment ? [environment] : [];
  });
  const others = Object.values(builder.environments).filter(
    (environment) =>
      workerEnvironments.length > 0 &&
      environment !== client &&
      !environmentNames.includes(environment.name) &&
      // Framework-owned environments we were told to leave alone may have
      // no build input; never drive them from the default orchestrator.
      !options.skipEnvironments?.includes(environment.name),
  );
  for (const environment of [...workerEnvironments, ...others]) {
    if (!environment.isBuilt) await builder.build(environment);
  }
  if (!client || client.isBuilt) return;
  const entry = workerEnvironments[0];
  const entryDirectory = entry
    ? path.resolve(builder.config.root, entry.config.build.outDir)
    : undefined;
  const importedAssets = entryDirectory ? readImportedAssets(entryDirectory) : new Set<string>();
  if (!isEntrylessClientEnvironment(client)) {
    await builder.build(client);
  } else if (importedAssets.size > 0 || hasPublicAssets(builder.config)) {
    client.config.build.rollupOptions = {
      input: CLIENT_FALLBACK_ENTRY_ID,
      logLevel: "silent",
      output: { entryFileNames: CLIENT_FALLBACK_ENTRY_NAME },
    };
    await builder.build(client);
    fs.rmSync(
      path.resolve(builder.config.root, client.config.build.outDir, CLIENT_FALLBACK_ENTRY_NAME),
      { force: true },
    );
  } else {
    return;
  }
  if (!entryDirectory) return;
  const clientDirectory = path.resolve(builder.config.root, client.config.build.outDir);
  for (const asset of importedAssets) {
    const source = path.join(entryDirectory, asset);
    const destination = path.join(clientDirectory, asset);
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(destination)) {
      fs.unlinkSync(source);
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(source, destination);
    }
  }
};

/** The assets the Worker's chunks import, from its build manifest. */
const readImportedAssets = (directory: string): Set<string> => {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, ".vite", "manifest.json"), "utf8"),
    ) as Record<string, { assets?: Array<string> }>;
    return new Set(Object.values(manifest).flatMap((chunk) => chunk.assets ?? []));
  } catch {
    return new Set();
  }
};

const hasPublicAssets = ({ publicDir }: { publicDir: string | false }): boolean => {
  if (!publicDir) return false;
  try {
    return fs.readdirSync(publicDir).length > 0;
  } catch {
    return false;
  }
};

/**
 * Vite always creates a default `client` environment, even for a pure Worker
 * app that has no browser bundle. Building it makes Vite fall back to its
 * default `index.html` entry, so the build fails on a file the app never
 * referenced. Treat the environment as absent unless the app gave it an entry
 * or serves an HTML shell.
 */
const isEntrylessClientEnvironment = (environment: {
  name: string;
  config: { root: string; build: { rollupOptions?: { input?: unknown } } };
}): boolean => {
  if (environment.name !== "client") return false;
  const build = environment.config.build as {
    rollupOptions?: { input?: unknown };
    rolldownOptions?: { input?: unknown };
  };
  if (build.rollupOptions?.input || build.rolldownOptions?.input) return false;
  return !fs.existsSync(path.join(environment.config.root, "index.html"));
};

const defaultEnvironmentEntries = (
  environmentName: string,
  userConfig: vite.UserConfig,
): vite.Rolldown.InputOption | undefined => {
  const environment = userConfig.environments?.[environmentName];
  return environment?.build?.rolldownOptions?.input ?? environment?.build?.rollupOptions?.input;
};

const asArray = (
  input: string | Array<string> | Record<string, string> | undefined,
): Array<string> | undefined => {
  if (!input) return;
  if (typeof input === "string") return [input];
  if (Array.isArray(input) && input.length > 0) return input;
  return Object.values(input);
};

const normalizeInput = (
  input: string | Array<string> | Record<string, string>,
): Record<string, string> => {
  if (typeof input === "string") {
    return { [path.parse(input).name || "index"]: input };
  } else if (Array.isArray(input)) {
    return Object.fromEntries(input.map((p) => [path.parse(p).name, p]));
  } else {
    return input;
  }
};

/**
 * Resolve path-like input entries against the Vite root. Worker entries are
 * round-tripped through a synthetic `\0distilled:user-entry:` id and resolved
 * with no importer, so a relative input (`./workers/app.ts`) would otherwise
 * resolve against `process.cwd()` — the wrong base whenever the build runs
 * outside the project root (e.g. from a monorepo infra package). A bare
 * specifier that names a real file under the root (`workers/app.ts`) is
 * treated as a path input, matching Vite's own input semantics; anything else
 * (virtual modules, package specifiers) passes through and resolves via
 * plugins.
 */
const resolveInputPaths = (input: Record<string, string>, root: string): Record<string, string> =>
  Object.fromEntries(Object.entries(input).map(([key, id]) => [key, resolveInputPath(id, root)]));

const resolveInputPath = (id: string, root: string): string => {
  if (path.isAbsolute(id)) return id;
  if (id.startsWith("./") || id.startsWith("../")) return path.resolve(root, id);
  const resolved = path.resolve(root, id);
  return fs.existsSync(resolved) ? resolved : id;
};

const wrapInput = (input: Record<string, string>) =>
  Object.fromEntries(Object.entries(input).map(([key, id]) => [key, workerEntryId(id)]));

// `bundler` names the reference whose defines to match: Wrangler's own
// bundler (plain Workers) or `@cloudflare/vite-plugin`, which leaves
// `navigator.userAgent` to workerd and `import.meta.hot` to Vite.
const getDefine = (
  options: BasePluginOptions,
  nodeEnv: string,
  bundler: "wrangler" | "vite",
): Record<string, string> => ({
  "process.env.NODE_ENV": JSON.stringify(nodeEnv),
  "global.process.env.NODE_ENV": JSON.stringify(nodeEnv),
  "globalThis.process.env.NODE_ENV": JSON.stringify(nodeEnv),
  ...(hasNodejsCompat(options.compatibilityFlags, options.compatibilityDate)
    ? {}
    : {
        "process.env": "{}",
        "global.process.env": "{}",
        "globalThis.process.env": "{}",
      }),
  ...(bundler === "wrangler" &&
  options.compatibilityDate &&
  options.compatibilityDate >= "2022-03-21"
    ? {
        "navigator.userAgent": '"Cloudflare-Workers"',
      }
    : {}),
  ...(bundler === "wrangler" && nodeEnv === "production"
    ? {
        "import.meta.hot": "false",
      }
    : {}),
});

const getOutputDirectory = (userConfig: vite.UserConfig, environmentName: string) => {
  const rootOutputDirectory = userConfig.build?.outDir ?? "dist";

  return (
    userConfig.environments?.[environmentName]?.build?.outDir ??
    path.join(rootOutputDirectory, environmentName)
  );
};
