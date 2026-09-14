import {
  getCloudflarePreset,
  nonPrefixedNodeModules,
} from "@cloudflare/unenv-preset";
import assert from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";
import { defineEnv } from "unenv";
import { createPlugin } from "../factory.ts";
import { isSkippedEnvironment } from "../options.ts";
import type { BasePluginOptions } from "../options.ts";
import { hasNodejsAls, hasNodejsCompat, toPosixPath } from "../utils.ts";

const ASYNC_HOOKS_REGEXP = /^(node:)?async_hooks$/;
const NODE_BUILTIN_MODULES_REGEXP = new RegExp(
  `^(${nonPrefixedNodeModules.join("|")}|node:.+)$`,
);

export const nodejsAlsPlugin = createPlugin("nodejs-als", (options) => {
  if (!hasNodejsAls(options.compatibilityFlags)) return;
  return {
    rolldown: {
      resolveId: {
        filter: { id: ASYNC_HOOKS_REGEXP },
        handler(id) {
          return { id, external: true };
        },
      },
    },
    vite: {
      enforce: "pre",
      configEnvironment(name) {
        if (name === "client") return;
        return {
          resolve: {
            builtins: ["async_hooks", "node:async_hooks"],
          },
          optimizeDeps: {
            exclude: ["async_hooks", "node:async_hooks"],
          },
        };
      },
    },
  };
});

export interface UnenvApi {
  polyfill: ReadonlyArray<string>;
  inject: { [injectedName: string]: string };
}

export const getUnenv = (options: BasePluginOptions) =>
  defineEnv({
    presets: [
      getCloudflarePreset({
        compatibilityDate: options.compatibilityDate,
        compatibilityFlags: options.compatibilityFlags,
      }),
    ],
  }).env;

export const nodejsUnenvPlugin = createPlugin<"nodejs-unenv", UnenvApi>(
  "nodejs-unenv",
  (options) => {
    if (!hasNodejsCompat(options.compatibilityFlags)) return;
    const { alias, inject, polyfill, external } = getUnenv(options);
    const entries = new Set(Object.values(alias));
    for (const globalInject of Object.values(inject)) {
      if (typeof globalInject === "string") {
        entries.add(globalInject);
      } else {
        entries.add(globalInject[0]);
      }
    }
    polyfill.forEach((module) => entries.add(module));
    external.forEach((module) => entries.delete(module));
    const require = createRequire(import.meta.url);
    const resolve = (id: string) => {
      if (alias[id] && !external.includes(alias[id])) {
        return require.resolve(alias[id]);
      }
      if (entries.has(id)) {
        return require.resolve(id);
      }
    };
    const RESOLVE_ID_FILTER = {
      id: [
        NODE_BUILTIN_MODULES_REGEXP,
        /^unenv\//,
        /^@cloudflare\/unenv-preset\//,
      ],
    };
    return {
      shared: {
        api: {
          polyfill,
          inject: Object.fromEntries(
            Object.entries(inject).map(([injectedName, moduleSpecifier]) => {
              assert(
                typeof moduleSpecifier === "string",
                `expected moduleSpecifier to be a string`,
              );
              return [injectedName, moduleSpecifier];
            }),
          ),
        },
      },
      rolldown: {
        resolveId: {
          filter: RESOLVE_ID_FILTER,
          handler(source, importer, options) {
            const resolved = resolve(source);
            if (!resolved) return;
            return this.resolve(resolved, importer, options);
          },
        },
      },
      vite: {
        enforce: "pre",
        async configEnvironment(name) {
          if (name === "client") return;
          const { esmExternalRequirePlugin } = await import("vite");
          return {
            resolve: {
              builtins: [...external],
            },
            ...(this.meta.rolldownVersion
              ? {
                  build: {
                    rolldownOptions: {
                      plugins: [
                        esmExternalRequirePlugin({
                          external: [...external],
                          skipDuplicateCheck: true,
                        }),
                      ],
                    },
                  },
                }
              : {}),
            optimizeDeps: {
              exclude: [
                ...nonPrefixedNodeModules,
                ...nonPrefixedNodeModules.map((module) => `node:${module}`),
                // New Node.js built-in modules are only published with the `node:` prefix.
                ...[
                  "node:sea",
                  "node:sqlite",
                  "node:test",
                  "node:test/reporters",
                ],
              ],
              ...(this.meta.rolldownVersion
                ? {
                    rolldownOptions: {
                      plugins: [
                        // In Vite 8, `require` calls are not automatically replaced when
                        // the format is ESM and `platform` is `neutral`.
                        esmExternalRequirePlugin({
                          external: [NODE_BUILTIN_MODULES_REGEXP],
                          skipDuplicateCheck: true,
                        }),
                      ],
                    },
                  }
                : {}),
            },
          };
        },
        async configureServer(server) {
          await Promise.all(
            Object.values(server.environments).flatMap(async (environment) => {
              // Framework-owned Node-side environments (e.g. Astro's `astro`
              // and `prerender`) must be left untouched — this is a
              // server-level hook, so `applyToEnvironment` cannot gate it.
              if (isSkippedEnvironment(options, environment.name)) return;
              const depsOptimizer = environment.depsOptimizer;
              if (!depsOptimizer) return;
              // Environments using Vite's no-discovery ("explicit") optimizer
              // throw on `registerMissingImport` by design; pre-bundling the
              // unenv polyfills is best-effort, so skip them.
              if (!supportsMissingImportRegistration(environment)) return;
              await depsOptimizer.init();
              return Array.from(entries).map((entry) => {
                const resolved = resolve(entry);
                if (!resolved) return;
                const registration = depsOptimizer.registerMissingImport(
                  entry,
                  resolved,
                );
                return registration?.processing;
              });
            }),
          );
        },
        resolveId: {
          filter: RESOLVE_ID_FILTER,
          handler(source, importer, options) {
            const resolved = resolve(source);
            if (!resolved) return;
            if (
              this.environment.mode === "dev" &&
              this.environment.depsOptimizer &&
              supportsMissingImportRegistration(this.environment)
            ) {
              // We are in dev mode (rather than build).
              // So let's pre-bundle this polyfill entry-point using the dependency optimizer.
              const { id } =
                this.environment.depsOptimizer.registerMissingImport(
                  source,
                  resolved,
                );
              // We use the unresolved path to the polyfill and let the dependency optimizer's
              // resolver find the resolved path to the bundled version.
              return this.resolve(id, importer, options);
            }
            return this.resolve(resolved, importer, options);
          },
        },
      },
    };
  },
);

/**
 * Vite's no-discovery ("explicit") dependency optimizer throws on
 * `registerMissingImport` by design, and third-party environments may not
 * implement it at all. Feature-detect before registering polyfill entries.
 */
const supportsMissingImportRegistration = (environment: {
  config: { optimizeDeps?: { noDiscovery?: boolean } };
  depsOptimizer?: { registerMissingImport?: unknown } | undefined;
}): boolean =>
  environment.config.optimizeDeps?.noDiscovery !== true &&
  typeof environment.depsOptimizer?.registerMissingImport === "function";

export const nodejsImportWarningPlugin = createPlugin(
  "nodejs-import-warning",
  (options) => {
    if (hasNodejsCompat(options.compatibilityFlags)) return;
    const imports = new Map<string, Set<string>>();
    let root = process.cwd();
    return {
      rolldown: {
        options(options) {
          if (options.cwd) {
            root = options.cwd;
          }
        },
      },
      vite: {
        enforce: "pre",
        configResolved(config) {
          root = config.root;
        },
      },
      shared: {
        buildStart() {
          imports.clear();
        },
        resolveId: {
          filter: { id: NODE_BUILTIN_MODULES_REGEXP },
          async handler(id, importer) {
            if (
              hasNodejsAls(options.compatibilityFlags) &&
              ASYNC_HOOKS_REGEXP.test(id)
            )
              return;
            if (importer) {
              if (!imports.has(id)) {
                imports.set(id, new Set());
              }
              imports.get(id)?.add(importer);
            }
            return { id, external: true };
          },
        },
        buildEnd() {
          const filteredImports: Array<{ id: string; importer: string }> = [];
          for (const [id, importers] of imports.entries()) {
            for (const importer of importers) {
              if (this.getModuleInfo(importer)) {
                filteredImports.push({ id, importer });
              }
            }
          }
          if (filteredImports.length > 0) {
            const message = [
              "Unexpected Node.js imports. ",
              'Do you need to enable the "nodejs_compat" compatibility flag? ',
              "Refer to https://developers.cloudflare.com/workers/runtime-apis/nodejs/ for more details.\n",
              ...filteredImports.map(
                ({ id, importer }) =>
                  ` - "${id}" imported from "${toPosixPath(path.relative(root, importer))}"\n`,
              ),
            ].join("");
            this.warn(message);
          }
        },
      },
    };
  },
);
