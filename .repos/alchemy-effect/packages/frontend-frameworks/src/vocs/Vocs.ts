/**
 * `Framework` implementation driving Vocs on Cloudflare Workers.
 *
 * Vocs 2.x is built on waku (its `vocs()` vite plugin composes waku's own
 * `waku/vite-plugins` — environments, adapter-alias, static-build, ... — with
 * vocs's mdx/config/patch plugins), but it does NOT use waku's
 * `unstable_combinedPlugins`, so `@alchemy.run/frontend-frameworks/waku`'s Framework layer
 * cannot drive it directly. This layer mirrors that package's orchestration
 * (see packages/frontend-frameworks/src/waku/Waku.ts) with vocs's plugin stack swapped in:
 *
 * - the deploy-target halves (wrangler-free adapter fork + cloudflare vite
 *   plugin pinned to waku's rsc entry) come from
 *   `@alchemy.run/frontend-frameworks/waku/cloudflare` — vocs uses waku's environments
 *   plugin, so the same rsc/ssr topology applies;
 * - the plugin stack is the one vocs's own CLI assembles
 *   (`[react(), vocs()]`), with the target's plugins injected ahead of
 *   vocs/waku's (the position where the workerd proxy middleware registers
 *   before waku's Node request bridge) and the adapter selected via vocs's
 *   `unstable_adapter` passthrough;
 * - the waku-parity vite config that `@alchemy.run/frontend-frameworks/waku` carries through
 *   the in-memory waku config (dedupe, workerd optimizeDeps, neutral rolldown
 *   platform) rides the inline vite config instead, since vocs owns the waku
 *   config it builds internally.
 */
import * as FrameworkCore from "../core/index.ts";
import { WAKU_SERVER_ENTRY_MODULE } from "../waku/Waku.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as vite from "vite";
import {
  selectVocsTargetInput,
  type VocsTarget,
  type VocsTargetOption,
} from "./Target.ts";

type ReactPluginModule = typeof import("@vitejs/plugin-react");
type VocsViteModule = typeof import("vocs/vite");

interface VocsProjectModules {
  readonly react: ReactPluginModule;
  readonly vite: VocsViteModule;
}

export interface VocsFrameworkOptions {
  /** Deploy target. Defaults to `@alchemy.run/frontend-frameworks/vocs/cloudflare`. */
  readonly target?: VocsTargetOption | undefined;
  /** @deprecated Target configuration alias retained for the E2E harness. */
  readonly vite?: unknown;
  /** Project root. Defaults to the operation root or current working directory. */
  readonly root?: string;
  /**
   * Default dev-server port, used when `dev` is called without an explicit
   * port (e.g. the Playwright dev fixture). Non-strict: if the port is taken,
   * vite falls back to the next free one. A port passed to `dev` directly
   * (`e2e dev --port N`) is strict and takes precedence.
   */
  readonly port?: number | undefined;
}

/**
 * `NODE_ENV` as it was when this module first loaded (see
 * packages/frontend-frameworks/src/waku/Waku.ts for the rationale: build and dev may run in the
 * same long-lived playwright worker process).
 */
const INITIAL_NODE_ENV = process.env.NODE_ENV;

const PREVIEW_SERVER_GLOBAL = "__WAKU_START_PREVIEW_SERVER__";

/** The shape waku's `unstable_startPreviewServer` expects the global to produce. */
interface WakuPreviewServer {
  readonly baseUrl: string;
  readonly middlewares: {
    readonly use: (
      fn: (req: unknown, res: unknown, next: (err?: unknown) => void) => void,
    ) => void;
  };
  readonly close: () => Promise<void>;
}

/**
 * Waku-parity inline vite config. `@alchemy.run/frontend-frameworks/waku` injects these via
 * the in-memory waku config's `vite` field; vocs builds that config itself
 * with `vite: {}`, so they ride the top-level inline config here (vite merges
 * inline config with plugin-contributed config).
 */
const sharedViteConfig = (): vite.InlineConfig => ({
  resolve: {
    dedupe: ["waku", "hono"],
  },
  environments: {
    rsc: {
      optimizeDeps: { include: ["hono/tiny"] },
      build: { rolldownOptions: { platform: "neutral" } },
    },
    ssr: {
      optimizeDeps: { include: ["waku > rsc-html-stream/server"] },
      build: { rolldownOptions: { platform: "neutral" } },
    },
  },
});

const VIRTUAL_USER_CONFIG = "virtual:alchemy-vocs/user-config";
const RESOLVED_VIRTUAL_USER_CONFIG = `\0${VIRTUAL_USER_CONFIG}`;

/**
 * Bridges vocs's runtime config resolution onto workerd.
 *
 * Vocs's server code calls `Config.resolve({ server: true })` at request time
 * (middleware, api routes, the ssr entry). In production that branch assumes
 * the Node server layout — `import.meta.dirname` + an on-disk
 * `dist/server/vocs.config.js` — neither of which exists inside workerd
 * (upstream vocs has node/vercel/netlify adapters only; there is no workers
 * deploy path to mirror). This plugin:
 *
 * 1. asks Vocs to discover the project's `vocs.config.*` file;
 * 2. exposes that file through a virtual module, so Vite loads and bundles
 *    the original config module (including its imports and functions);
 * 3. transforms Vocs's Node-only runtime lookup to import the bundled module
 *    and guards the `process.cwd()` fallback for workerd.
 *
 * This follows Vocs's own production design, which emits the config as
 * `dist/server/vocs.config.js`, without separately resolving or serializing
 * the user's configuration in Alchemy.
 */
const workerdConfigBridge = (configPath: string | undefined): vite.Plugin => {
  return {
    name: "@alchemy.run/frontend-frameworks/vocs:workerd-config-bridge",
    resolveId(id) {
      if (id === VIRTUAL_USER_CONFIG) return RESOLVED_VIRTUAL_USER_CONFIG;
      return;
    },
    load(id) {
      if (id === RESOLVED_VIRTUAL_USER_CONFIG) {
        return configPath === undefined
          ? "export default {};"
          : `export { default } from ${JSON.stringify(configPath)};`;
      }
      return;
    },
    transform(code, id) {
      // In the production build the modules are vocs's shipped
      // `dist/internal/*.js`; in dev, vite serves vocs's TS sources
      // (`src/internal/*.ts`) through the module runner, so both shapes (and
      // the raw-TS formatting, which user plugins see before vite's esbuild
      // transform) must match.
      // Strip the query (dev serves ids like `.../config.js?v=<hash>`).
      const normalized = (id.split("?")[0] ?? id).replaceAll("\\", "/");
      const isVocsInternal = (name: string) =>
        normalized.endsWith(`/vocs/dist/internal/${name}.js`) ||
        normalized.endsWith(`/vocs/src/internal/${name}.ts`);
      const mustReplace = (
        source: string,
        pattern: RegExp,
        replacement: string,
      ): string => {
        if (!pattern.test(source)) {
          throw new Error(
            `@alchemy.run/frontend-frameworks/vocs: ${normalized} no longer matches the workerd config bridge ` +
              `pattern ${pattern} — update the transform in packages/frontend-frameworks/src/vocs/Vocs.ts ` +
              "for the installed vocs version",
          );
        }
        return source.replace(pattern, replacement);
      };
      // `deserializeFunctions` revives `_vocs-fn_`-serialized config functions
      // with `new Function`, which workerd forbids. Vocs' server runtime does
      // not need the browser-side search callbacks that take this path, so
      // degrade them to `undefined` when dynamic evaluation is unavailable.
      // Node paths (SSG and dev tooling) still revive them normally.
      if (isVocsInternal("config-serializer")) {
        return mustReplace(
          code,
          // Avoid the escaped copy inside `deserializeFunctionsStringified`.
          /return new Function\(`return \$\{value\.slice\(9\)\}`\)\(\);?/,
          "try { return new Function(`return ${value.slice(9)}`)(); } catch { return undefined; }",
        );
      }
      if (!isVocsInternal("config")) return;
      let result = mustReplace(
        code,
        /const \{ server, rootDir = process\.cwd\(\) \} = options;?/,
        "const { server } = options;\n" +
          "  const rootDir = options.rootDir ?? (() => { try { return process.cwd(); } catch { return '/'; } })();",
      );
      result = mustReplace(
        result,
        /if \(server && process\.env\['NODE_ENV'\] === 'production'\) \{\s*const configPath = path\.resolve\(import\.meta\.dirname, '\.\.\/vocs\.config\.js'\);?\s*const resolved = \(await import\(\/\* @vite-ignore \*\/ configPath\)\)\.default( as define\.Options)?;?\s*return define\(\{ \.\.\.resolved, rootDir \}\);?\s*\}/,
        "if (server) {\n" +
          `    const resolved = (await import(${JSON.stringify(VIRTUAL_USER_CONFIG)})).default;\n` +
          "    return define(resolved);\n" +
          "  }",
      );
      return result;
    },
  };
};

/**
 * Replicates waku's `cmd-build.ts` `startPreviewServerImpl`: the SSG step of
 * `builder.buildApp()` (the adapter's `build`) calls
 * `unstable_startPreviewServer`, which throws unless this global is set. The
 * preview config omits the cloudflare plugins, so SSG streams through the
 * adapter's Node fallback middleware (upstream parity: identical to a vocs
 * build without a platform vite plugin).
 */
const setPreviewServerGlobal = (
  root: string,
  adapterPath: string,
  configPath: string | undefined,
  project: VocsProjectModules,
): void => {
  (globalThis as Record<string, unknown>)[PREVIEW_SERVER_GLOBAL] =
    async (): Promise<WakuPreviewServer> => {
      const server = await vite.preview({
        configFile: false,
        root,
        ...sharedViteConfig(),
        plugins: [
          project.react.default(),
          workerdConfigBridge(configPath),
          project.vite.vocs({ unstable_adapter: adapterPath }),
        ],
      });
      const baseUrl = server.resolvedUrls?.local[0];
      if (!baseUrl) {
        throw new Error(
          "Could not determine the URL of the vocs SSG preview server",
        );
      }
      return {
        baseUrl,
        middlewares: {
          use: (fn) => server.middlewares.use(fn as never),
        },
        close: () => server.close(),
      };
    };
};

const clearPreviewServerGlobal = (): void => {
  delete (globalThis as Record<string, unknown>)[PREVIEW_SERVER_GLOBAL];
};

/**
 * The vocs implementation of framework-core's `Framework` service.
 *
 * - `build` replicates vocs's `vocs build` CLI command (`vite.createBuilder`
 *   with `[react(), vocs()]` + `buildApp`) with the cloudflare target's
 *   plugins/adapter wired in, and collects the `BuildOutput` with a
 *   post-`buildApp` disk re-read (waku writes `__waku_build_metadata.js` and
 *   prunes static-only chunks after the bundler finishes).
 * - `dev` replicates `vocs dev` (`vite.createServer`) with the same plugin
 *   wiring, so the rsc environment runs in workerd.
 */
export const make = (
  options: VocsFrameworkOptions = {},
): Layer.Layer<
  FrameworkCore.Framework,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    FrameworkCore.Framework,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const fail = (message: string) => (cause: unknown) =>
        new FrameworkCore.FrameworkError({ framework: "vocs", message, cause });

      const resolveRoot = (override: string | undefined) =>
        Effect.sync(() => override ?? options.root ?? process.cwd());

      const resolveTarget = (root: string) => {
        const { input, config } = selectVocsTargetInput(options);
        return FrameworkCore.resolveDeployTarget<VocsTarget, unknown>(
          root,
          input,
          config,
        ).pipe(Effect.mapError(fail("Failed to resolve the deploy target")));
      };

      const findConfig = (root: string) =>
        Effect.gen(function* () {
          for (const name of [
            "vocs.config.ts",
            "vocs.config.js",
            "vocs.config.mjs",
            "vocs.config.mts",
          ]) {
            const candidate = path.join(root, name);
            if (yield* fs.exists(candidate)) return candidate;
          }
          return undefined;
        }).pipe(Effect.mapError(fail("Failed to locate the Vocs config")));

      const loadProject = (root: string) =>
        Effect.all(
          {
            react: FrameworkCore.loadProjectModule<ReactPluginModule>(
              root,
              "@vitejs/plugin-react",
            ),
            vite: FrameworkCore.loadProjectModule<VocsViteModule>(
              root,
              "vocs/vite",
            ),
          },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            fail("Failed to load Vocs from the project dependencies"),
          ),
        );

      /** Resolve the target's adapter module + vite plugins for one pass. */
      const prepareTarget = Effect.fn(function* (
        target: VocsTarget,
        root: string,
        phase: "build" | "dev",
      ) {
        const wakuDirectory =
          yield* FrameworkCore.resolveProjectPackageDirectory(
            root,
            "waku",
          ).pipe(
            Effect.mapError(
              fail("Failed to resolve the project's waku package directory"),
            ),
          );
        const context = { root, wakuDirectory, phase } as const;
        const [adapterPath, plugins] = yield* Effect.all(
          [target.adapter(context), target.vitePlugins(context)],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            fail(`The cloudflare target failed preparing the vocs ${phase}`),
          ),
        );
        return { adapterPath, plugins, wakuDirectory };
      });

      return FrameworkCore.Framework.of({
        build: Effect.fn(function* (buildOptions) {
          const root = yield* resolveRoot(buildOptions?.root);
          const target = yield* resolveTarget(root);
          if (target.build !== undefined) {
            return yield* target
              .build({ root, framework: "vocs", env: buildOptions?.env })
              .pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.mapError(fail("The deploy target's build failed")),
              );
          }
          const { adapterPath, plugins } = yield* prepareTarget(
            target,
            root,
            "build",
          );
          const project = yield* loadProject(root);
          const configPath = yield* findConfig(root);
          // vocs's CLI (like waku's) runs with NODE_ENV set before loading
          // anything; waku's environmentsPlugin bakes it into `define`.
          yield* Effect.sync(() => {
            process.env.NODE_ENV = INITIAL_NODE_ENV ?? "production";
          });
          const collector = yield* FrameworkCore.makeBuildOutputCollector({
            entryEnvironment: "rsc",
            selectEntry: (chunk) => chunk.name === WAKU_SERVER_ENTRY_MODULE,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          yield* Effect.tryPromise({
            try: async () => {
              const builder = await vite.createBuilder(
                {
                  configFile: false,
                  root,
                  ...sharedViteConfig(),
                  plugins: [
                    project.react.default(),
                    ...plugins,
                    workerdConfigBridge(configPath),
                    project.vite.vocs({ unstable_adapter: adapterPath }),
                    collector.plugin,
                  ],
                },
                null,
              );
              setPreviewServerGlobal(root, adapterPath, configPath, project);
              try {
                await builder.buildApp();
              } finally {
                clearPreviewServerGlobal();
              }
            },
            catch: fail("Failed to build"),
          });
          // Disk re-read: waku writes `__waku_build_metadata.js` and prunes
          // static-only server chunks during `buildApp` hooks, after the
          // in-memory `writeBundle` capture.
          const output = yield* collector
            .collect({ fromDisk: true })
            .pipe(Effect.mapError((error) => fail(error.message)(error.cause)));
          return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
            root,
            framework: "vocs",
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.mapError(fail("The deploy target's finishing pass failed")),
          );
        }),
        dev: Effect.fn(function* (devOptions) {
          const root = yield* resolveRoot(devOptions?.root);
          const target = yield* resolveTarget(root);
          const { adapterPath, plugins } = yield* prepareTarget(
            target,
            root,
            "dev",
          );
          const project = yield* loadProject(root);
          const configPath = yield* findConfig(root);
          yield* Effect.sync(() => {
            process.env.NODE_ENV = INITIAL_NODE_ENV ?? "development";
          });
          const port = devOptions?.port ?? options.port;
          const server = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: async () => {
                const server = await vite.createServer({
                  configFile: false,
                  root,
                  ...sharedViteConfig(),
                  plugins: [
                    project.react.default(),
                    ...plugins,
                    workerdConfigBridge(configPath),
                    project.vite.vocs({ unstable_adapter: adapterPath }),
                  ],
                  ...(port !== undefined
                    ? {
                        server: {
                          port,
                          strictPort: devOptions?.port !== undefined,
                        },
                      }
                    : undefined),
                });
                return await server.listen();
              },
              catch: fail("Failed to start the vocs dev server"),
            }),
            (server) =>
              Effect.promise(async () => {
                try {
                  (
                    server.httpServer as
                      | { closeAllConnections?: () => void }
                      | null
                      | undefined
                  )?.closeAllConnections?.();
                  await server.close();
                } catch {
                  // teardown is best-effort
                }
              }).pipe(
                Effect.timeout("3 seconds"),
                Effect.orElseSucceed(() => undefined),
              ),
          );
          const url = server.resolvedUrls?.local[0];
          if (url === undefined) {
            return yield* Effect.fail(
              fail("Could not determine the URL of the vocs dev server")(
                undefined,
              ),
            );
          }
          return { url };
        }),
      });
    }),
  );

export default make;
