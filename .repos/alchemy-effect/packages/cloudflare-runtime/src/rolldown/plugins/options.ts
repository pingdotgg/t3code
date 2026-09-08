import fs from "node:fs";
import path from "node:path";
import type * as vite from "vite";
import { createPlugin } from "../factory.ts";
import { parseViteEnvironments, type BasePluginOptions } from "../options.ts";
import { hasNodejsCompat } from "../utils.ts";
import { workerEntryId } from "./virtual-modules.ts";

const DEFAULT_RESOLVE_CONDITION_NAMES = [
  "workerd",
  "worker",
  "module",
  "browser",
];
const DEFAULT_RESOLVE_MAIN_FIELDS = [
  "browser",
  "module",
  "jsnext:main",
  "jsnext",
  "main",
];
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

const TARGET = "es2024";

export interface OptionsApi {
  input: () => Record<string, string>;
}

export const optionsPlugin = createPlugin<"options", OptionsApi>(
  "options",
  (pluginOptions) => {
    let input: Record<string, string> = {};
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
          options.resolve.conditionNames ??= [
            ...DEFAULT_RESOLVE_CONDITION_NAMES,
            "production",
          ];
          options.resolve.mainFields ??= DEFAULT_RESOLVE_MAIN_FIELDS;
          options.resolve.extensions ??= DEFAULT_RESOLVE_EXTENSIONS;
          options.transform ??= {};
          options.transform.target ??= TARGET;
          options.transform.define ??= {};
          Object.assign(
            options.transform.define,
            getDefine(pluginOptions, "production"),
          );
          return options;
        },
      },
      vite: {
        async config(userConfig) {
          const vite = await import("vite");
          const isRolldown = "rolldownVersion" in this.meta;
          const environmentNames = parseViteEnvironments(pluginOptions);
          const root = path.resolve(userConfig.root ?? ".");
          input = resolveInputPaths(
            normalizeInput(
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
          );
          const makeEnvironment = ({
            name,
            isEntry,
          }: {
            name: string;
            isEntry: boolean;
          }): vite.EnvironmentOptions => {
            const entries = isEntry
              ? (pluginOptions.main ??
                defaultEnvironmentEntries(name, userConfig))
              : (defaultEnvironmentEntries(name, userConfig) ??
                pluginOptions.main);
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
                conditions: [
                  ...DEFAULT_RESOLVE_CONDITION_NAMES,
                  "development|production",
                ],
              },
              optimizeDeps: {
                noDiscovery: false,
                ignoreOutdatedRequests: true,
                entries: asArray(entries)?.map(vite.normalizePath),
                ...(isRolldown
                  ? {
                      rolldownOptions: {
                        platform: "neutral",
                        resolve: {
                          conditionNames: [
                            ...DEFAULT_RESOLVE_CONDITION_NAMES,
                            "development|production",
                          ],
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
                        conditions: [
                          ...DEFAULT_RESOLVE_CONDITION_NAMES,
                          "development|production",
                        ],
                        resolveExtensions: DEFAULT_RESOLVE_EXTENSIONS,
                        mainFields: DEFAULT_RESOLVE_MAIN_FIELDS,
                        target: TARGET,
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
                      target: TARGET,
                      emitAssets: true,
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
          const appType =
            userConfig.appType ??
            (Object.keys(input).length === 0 ? "spa" : "custom");
          return {
            appType,
            builder:
              // Vite merges plugin `config` results over the user config, so an
              // unconditional default here would clobber a framework's own
              // `buildApp` orchestrator (e.g. Astro's prerender -> ssr -> client
              // pipeline). Only default it when the resolved user config doesn't
              // already define one.
              appType === "spa" || userConfig.builder?.buildApp !== undefined
                ? undefined
                : {
                    // We need to include this for `builder.buildApp()` to work
                    // because not all frameworks provide it...
                    buildApp: async (builder) => {
                      for (const environment of Object.values(
                        builder.environments,
                      )) {
                        // Framework-owned environments we were told to leave
                        // alone may have no build input; never drive them from
                        // our default orchestrator.
                        if (
                          pluginOptions.skipEnvironments?.includes(
                            environment.name,
                          )
                        )
                          continue;
                        // ...however, if your framework does provide a `buildApp` hook,
                        // this check prevents us from building the environment twice.
                        if (environment.isBuilt) continue;
                        // `skipEnvironments` opts out of environments the app
                        // declared; this covers the one Vite creates unasked.
                        if (isEntrylessClientEnvironment(environment)) continue;
                        await builder.build(environment);
                      }
                    },
                  },
            ssr: {
              noExternal: true,
              resolve: {
                conditions: [
                  ...DEFAULT_RESOLVE_CONDITION_NAMES,
                  "development|production",
                ],
              },
            },
            environments: {
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
  },
);

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
  return (
    environment?.build?.rolldownOptions?.input ??
    environment?.build?.rollupOptions?.input
  );
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
const resolveInputPaths = (
  input: Record<string, string>,
  root: string,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(input).map(([key, id]) => [key, resolveInputPath(id, root)]),
  );

const resolveInputPath = (id: string, root: string): string => {
  if (path.isAbsolute(id)) return id;
  if (id.startsWith("./") || id.startsWith("../"))
    return path.resolve(root, id);
  const resolved = path.resolve(root, id);
  return fs.existsSync(resolved) ? resolved : id;
};

const wrapInput = (input: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(input).map(([key, id]) => [key, workerEntryId(id)]),
  );

const getDefine = (
  options: BasePluginOptions,
  nodeEnv: string,
): Record<string, string> => {
  return {
    "process.env.NODE_ENV": JSON.stringify(nodeEnv),
    "global.process.env.NODE_ENV": JSON.stringify(nodeEnv),
    "globalThis.process.env.NODE_ENV": JSON.stringify(nodeEnv),
    ...(hasNodejsCompat(options.compatibilityFlags)
      ? {}
      : {
          "process.env": "{}",
          "global.process.env": "{}",
          "globalThis.process.env": "{}",
        }),
    ...(options.compatibilityDate && options.compatibilityDate >= "2022-03-21"
      ? {
          "navigator.userAgent": '"Cloudflare-Workers"',
        }
      : {}),
    ...(nodeEnv === "production"
      ? {
          "import.meta.hot": "false",
        }
      : {}),
  };
};

const getOutputDirectory = (
  userConfig: vite.UserConfig,
  environmentName: string,
) => {
  const rootOutputDirectory = userConfig.build?.outDir ?? "dist";

  return (
    userConfig.environments?.[environmentName]?.build?.outDir ??
    path.join(rootOutputDirectory, environmentName)
  );
};
