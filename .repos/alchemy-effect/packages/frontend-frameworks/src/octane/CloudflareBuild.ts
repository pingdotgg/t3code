/*!
 * Client metadata collection adapted from @octanejs/vite-plugin 0.1.22.
 * MIT License
 * Copyright (c) 2026 Dominic Gannaway
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { InlineConfig, Plugin, PluginOption } from "vite";
import { createRequire } from "node:module";
import {
  FrameworkError,
  loadProjectModule,
  resolveProjectPackageDirectory,
} from "../core/index.ts";
import { readOctaneOutput } from "./Octane.ts";

interface OctaneConfig {
  readonly adapter?: { readonly name?: string };
  readonly router: {
    readonly routes: ReadonlyArray<{
      readonly type: string;
      readonly entry?: unknown;
      readonly layout?: string;
    }>;
    readonly preHydrate?: string;
  };
  readonly rootBoundary: {
    readonly pending?: unknown;
    readonly catch?: unknown;
  };
  readonly build: {
    readonly outDir: string;
    readonly minify?: boolean;
    readonly target?: string;
  };
}

interface OctanePluginModule {
  readonly loadOctaneConfig: (root: string) => Promise<OctaneConfig | null>;
  readonly getOctaneConfigPath: (root: string) => string;
  readonly get_route_entry_path: (entry: unknown) => string | undefined;
}

interface ManifestEntry {
  readonly file: string;
  readonly src?: string;
  readonly css?: string[];
  readonly imports?: string[];
  readonly dynamicImports?: string[];
}

type ClientAssets = Record<string, { js: string; css: string[] }>;

const fail = (message: string, cause?: unknown) =>
  new FrameworkError({ framework: "octane", message, cause });

/** Keep Octane's compiler and client hooks; Alchemy builds the server separately. */
export const clientPlugins = (
  options: ReadonlyArray<PluginOption>,
): Effect.Effect<Plugin[], FrameworkError> =>
  Effect.gen(function* () {
    const plugins: Plugin[] = [];
    const visit = (option: PluginOption): Effect.Effect<void, FrameworkError> =>
      Effect.gen(function* () {
        const resolved = yield* Effect.tryPromise({
          try: () => Promise.resolve(option),
          catch: (cause) => fail("Failed to resolve a Vite plugin", cause),
        });
        if (Array.isArray(resolved)) {
          for (const child of resolved) yield* visit(child);
        } else if (resolved) {
          plugins.push(resolved);
        }
      });
    for (const option of options) yield* visit(option);
    const octane = plugins.filter(
      (plugin) => plugin.name === "@octanejs/vite-plugin",
    );
    if (octane.length !== 1 || octane[0]?.closeBundle === undefined) {
      return yield* Effect.fail(
        fail(
          "Expected one native octane() Vite plugin with a server build hook",
        ),
      );
    }
    return plugins.map((plugin) =>
      plugin === octane[0] ? { ...plugin, closeBundle: undefined } : plugin,
    );
  });

/** Generate the Worker entry without importing build-time adapter code. */
export const workerEntry = (options: {
  readonly manifest: string;
  readonly production: string;
  readonly htmlTemplate: string;
}) => `import { manifest, rendererDeps } from ${JSON.stringify(options.manifest)};
import { createHandler } from ${JSON.stringify(options.production)};

let handler;
export default {
  fetch(request, env, ctx) {
    handler ??= createHandler(manifest, {
      ...rendererDeps,
      htmlTemplate: ${JSON.stringify(options.htmlTemplate)},
    });
    return handler(request, { env, ctx });
  },
};
`;

export const buildCloudflare = (rootDirectory: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.resolve(rootDirectory);
      const vite = yield* loadProjectModule<typeof import("vite")>(
        root,
        "vite",
      );
      const pluginDirectory = yield* resolveProjectPackageDirectory(
        root,
        "@octanejs/vite-plugin",
      ).pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const resolveModule = yield* Effect.sync(
        () => createRequire(path.join(pluginDirectory, "package.json")).resolve,
      );
      const octane = yield* loadProjectModule<OctanePluginModule>(
        root,
        "@octanejs/vite-plugin",
      );
      const codegen = yield* loadProjectModule<{
        generateServerEntry: (options: Record<string, unknown>) => string;
      }>(pluginDirectory, "@octanejs/app-core/codegen");
      const assetHelper = yield* loadProjectModule<{
        createClientAssetMap: (
          manifest: Record<string, ManifestEntry>,
          entries: string[],
          files: Record<string, string>,
        ) => ClientAssets;
      }>(pluginDirectory, path.join(pluginDirectory, "src/client-assets.js"));
      const config = yield* Effect.tryPromise({
        try: () => octane.loadOctaneConfig(root),
        catch: (cause) => fail("Failed to load octane.config.ts", cause),
      });
      if (config === null || config.router.routes.length === 0) {
        return yield* Effect.fail(
          fail(
            "A fullstack Octane app with octane.config.ts routes is required",
          ),
        );
      }
      if (
        config.adapter !== undefined &&
        config.adapter.name !== "cloudflare"
      ) {
        return yield* Effect.fail(
          fail(
            `The Octane adapter "${config.adapter.name}" is incompatible with Cloudflare`,
          ),
        );
      }
      const entries = yield* Effect.sync(() => [
        ...new Set(
          [
            ...config.router.routes
              .filter((route) => route.type === "render")
              .flatMap((route) => [
                octane.get_route_entry_path(route.entry),
                route.layout,
              ]),
            config.router.preHydrate,
            octane.get_route_entry_path(config.rootBoundary.pending),
            octane.get_route_entry_path(config.rootBoundary.catch),
          ].filter((entry): entry is string => typeof entry === "string"),
        ),
      ]);
      const loadConfig = (ssr: boolean) =>
        Effect.tryPromise({
          try: () =>
            vite.loadConfigFromFile(
              { command: "build", mode: "production", isSsrBuild: ssr },
              undefined,
              root,
              "warn",
            ),
          catch: (cause) => fail("Failed to load vite.config", cause),
        }).pipe(Effect.map((loaded) => loaded?.config ?? {}));
      const clientConfig = yield* loadConfig(false);
      const plugins = yield* clientPlugins(clientConfig.plugins ?? []);
      if (
        clientConfig.root !== undefined &&
        path.resolve(root, clientConfig.root) !== root
      ) {
        return yield* Effect.fail(
          fail(
            "Set rootDir to the Octane app root instead of overriding Vite root",
          ),
        );
      }
      let clientDir = path.resolve(root, config.build.outDir, "client");
      const rpcModules = new Set<string>();
      const entryFiles: Record<string, string> = {};
      const collect: Plugin = {
        name: "alchemy:octane-client-metadata",
        configResolved(config) {
          clientDir = path.resolve(config.root, config.build.outDir);
        },
        transform(code, id, options) {
          const file = id.split("?")[0]!;
          if (
            options?.ssr ||
            !/\.(tsrx|tsx)$/.test(file) ||
            !code.includes("_$__serverRpc(")
          )
            return;
          const relative = path.relative(root, file);
          rpcModules.add(
            relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
              ? file
              : `/${relative.replaceAll("\\", "/")}`,
          );
        },
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type !== "chunk") continue;
            for (const entry of entries) {
              const id = path
                .resolve(root, entry.startsWith("/") ? `.${entry}` : entry)
                .replaceAll("\\", "/");
              if (
                output.moduleIds.some(
                  (module) => module.replaceAll("\\", "/") === id,
                )
              ) {
                entryFiles[entry] ??= output.fileName;
              }
            }
          }
        },
      };
      const serverDir = path.resolve(root, config.build.outDir, "server");
      yield* Effect.tryPromise({
        try: () =>
          vite.build({
            ...clientConfig,
            root,
            configFile: false,
            plugins: plugins.flatMap((plugin) =>
              plugin.name === "@octanejs/vite-plugin"
                ? [plugin, collect]
                : [plugin],
            ),
            logLevel: "warn",
          }),
        catch: (cause) => fail("Failed to build the Octane client", cause),
      });
      const manifest = yield* fs
        .readFileString(path.join(clientDir, ".vite/manifest.json"))
        .pipe(
          Effect.flatMap((source) =>
            Effect.try({
              try: () => JSON.parse(source) as Record<string, ManifestEntry>,
              catch: (cause) => fail("Invalid Octane client manifest", cause),
            }),
          ),
        );
      const clientAssets = yield* Effect.sync(() =>
        assetHelper.createClientAssetMap(manifest, entries, entryFiles),
      );
      const htmlTemplate = yield* fs.readFileString(
        path.join(clientDir, "index.html"),
      );
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: root,
        prefix: ".alchemy-octane-worker-",
      });
      const manifestFile = path.join(directory, "manifest.mjs");
      const workerFile = path.join(directory, "worker.mjs");
      const production = yield* Effect.try(() =>
        resolveModule("@octanejs/app-core/production"),
      );
      const source = yield* Effect.try({
        try: () =>
          codegen.generateServerEntry({
            routes: config.router.routes,
            rootBoundary: config.rootBoundary,
            octaneConfigPath: octane.getOctaneConfigPath(root),
            rpcModulePaths: [...rpcModules],
            clientAssetMap: clientAssets,
            mode: "manifest",
            configModuleId: resolveModule("@octanejs/app-core/config"),
            serverRuntimeModuleId: resolveModule("octane/server"),
            staticRuntimeModuleId: resolveModule("octane/static"),
            generatedBy: "@alchemy.run/frontend-frameworks",
          }),
        catch: (cause) =>
          fail("Failed to generate the Octane server manifest", cause),
      });
      yield* fs.writeFileString(manifestFile, source);
      const workerSource = yield* Effect.sync(() =>
        workerEntry({ manifest: manifestFile, production, htmlTemplate }),
      );
      yield* fs.writeFileString(workerFile, workerSource);
      const serverConfig = yield* loadConfig(true);
      const serverOptions: InlineConfig = yield* Effect.sync(() =>
        vite.mergeConfig(serverConfig, {
          root,
          configFile: false,
          appType: "custom",
          logLevel: "warn",
          define: { "process.env.NODE_ENV": JSON.stringify("production") },
          resolve: {
            conditions: [
              "workerd",
              "worker",
              "module",
              "browser",
              "production",
            ],
            alias: [
              {
                find: /^@octanejs\/vite-plugin$/,
                replacement: path.join(pluginDirectory, "src/config-entry.js"),
              },
            ],
          },
          build: {
            outDir: serverDir,
            emptyOutDir: true,
            ssr: true,
            target: config.build.target,
            minify: config.build.minify ?? false,
            rollupOptions: {
              input: workerFile,
              external: [/^(node|cloudflare):/],
              output: { entryFileNames: "worker.js", format: "esm" },
            },
          },
          ssr: {
            target: "webworker",
            noExternal: true,
            external: ["vite"],
            resolve: {
              conditions: [
                "workerd",
                "worker",
                "module",
                "browser",
                "production",
              ],
            },
          },
        } satisfies InlineConfig),
      );
      yield* Effect.tryPromise({
        try: () => vite.build(serverOptions),
        catch: (cause) => fail("Failed to build the Octane Worker", cause),
      });
      yield* fs.remove(path.join(clientDir, "index.html"));
      yield* fs.remove(path.join(clientDir, ".vite"), { recursive: true });
      return yield* readOctaneOutput({
        dir: path.resolve(root, config.build.outDir),
        clientDir,
        serverDir,
        serverEntryFileName: "worker.js",
      });
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof FrameworkError
          ? cause
          : fail("Failed to build Octane for Cloudflare", cause),
      ),
    ),
  );
