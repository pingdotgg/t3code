/**
 * Shared programmatic Vinext builds and native development CLI helpers.
 * Production builds run in the target's isolated Node child so Alchemy can
 * inject deployment adapters without modifying application configuration.
 */
import * as FrameworkCore from "../core/index.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type { Plugin, PluginOption } from "vite";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { loadVinextBuildConfig } from "./BuildConfig.ts";
import type * as NodeChildProcessModule from "node:child_process";
import type * as NodeNet from "node:net";
import { findEphemeralPort } from "../core/DevPort.ts";
import {
  loadProjectModule,
  resolveProjectPackageDirectory,
} from "../core/Loader.ts";
import { makeVinextCachePlugin, type VinextCacheKind } from "./cache/plugin.ts";
import { runVinextPrerenderIfConfigured } from "./Prerender.ts";
import { loadVinextModule } from "./Modules.ts";
import { toOutputFile, type BuildOutput } from "../core/index.ts";

export const failFramework = (message: string) => (cause: unknown) =>
  new FrameworkCore.FrameworkError({ framework: "vinext", message, cause });

/** App Router RSC entry vinext writes under `dist/server`. */
export const VINEXT_RSC_ENTRY = "server/index.js";

/** Pages Router server entry vinext writes under `dist/server`. */
export const VINEXT_PAGES_ENTRY = "server/entry.js";

export const resolveVinextCli = (root: string) =>
  resolveProjectPackageDirectory(root, "vinext").pipe(
    Effect.map((directory) => `${directory}/dist/cli.js`),
    Effect.mapError(
      failFramework(
        `Failed to resolve "vinext" from ${root}. It must be installed in your project.`,
      ),
    ),
  );

export const runVinextBuild = (options: {
  readonly root: string;
  readonly cache: VinextCacheKind;
}) =>
  Effect.gen(function* () {
    const { root } = options;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* Effect.sync(() => {
      process.env.NODE_ENV = "production";
    });
    const vite = yield* loadProjectModule<typeof import("vite")>(root, "vite");
    const { default: vinext } = yield* loadVinextModule<{
      default(options?: { disableAppRouter?: boolean }): PluginOption;
    }>(root, "index.js");
    const cache = yield* makeVinextCachePlugin(root, options.cache);
    const { loadDotenv } = yield* loadVinextModule<{
      loadDotenv(options: { root: string; mode: string }): void;
    }>(root, "config/dotenv.js");
    yield* Effect.sync(() => loadDotenv({ root, mode: "production" }));
    const loaded = yield* Effect.tryPromise(() =>
      vite.loadConfigFromFile(
        { command: "build", mode: "production" },
        undefined,
        root,
      ),
    );
    const plugins = loaded?.config.plugins ?? [vinext()];
    const config = yield* loadVinextBuildConfig(root, plugins);
    const { runWithPreviewBuildCredentials } = yield* loadVinextModule<{
      runWithPreviewBuildCredentials<T>(callback: () => T): T;
    }>(root, "build/preview-credentials.js");
    const { clearPagesClientAssetsBuildMetadata } = yield* loadVinextModule<{
      clearPagesClientAssetsBuildMetadata(session: string): void;
    }>(root, "build/pages-client-assets-module.js");
    const hasDirectory = (name: string) =>
      Effect.gen(function* () {
        return (
          (yield* fs.exists(path.join(root, name))) ||
          (yield* fs.exists(path.join(root, "src", name)))
        );
      });
    const hybrid =
      (yield* hasDirectory("app")) && (yield* hasDirectory("pages"));
    if (loaded?.config.build?.emptyOutDir !== false) {
      yield* fs.remove(path.join(root, "dist"), {
        recursive: true,
        force: true,
      });
    }
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const shared = {
          __VINEXT_SHARED_BUILD_ID: config.nextConfig.buildId,
          __VINEXT_SHARED_RSC_COMPATIBILITY_ID: config.rscCompatibilityId,
          __VINEXT_SHARED_RSC_BUILD_IDENTITY: randomBytes(16).toString("hex"),
          __VINEXT_SHARED_REVALIDATE_SECRET: randomBytes(32).toString("hex"),
          __VINEXT_SHARED_PRERENDER_SECRET: randomBytes(32).toString("hex"),
          ...(hybrid
            ? {
                __VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION:
                  randomBytes(16).toString("hex"),
              }
            : {}),
        };
        const previous = Object.fromEntries(
          Object.keys(shared).map((key) => [key, process.env[key]]),
        );
        Object.assign(process.env, shared);
        return {
          previous,
          session: shared.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION,
        };
      }),
      () =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            runWithPreviewBuildCredentials(async () => {
              const buildConfig = await vite.loadConfigFromFile(
                { command: "build", mode: "production" },
                undefined,
                root,
              );
              const builder = await vite.createBuilder({
                ...buildConfig?.config,
                root,
                configFile: false,
                plugins: [buildConfig?.config.plugins ?? [vinext()], cache],
                logLevel: "warn",
              });
              await builder.buildApp();
              if (!hybrid) return;
              // The native App Router builder leaves the hybrid Pages server to its caller.
              const flattened: Plugin[] = [];
              const flatten = async (value: PluginOption): Promise<void> => {
                const plugin = await value;
                if (Array.isArray(plugin)) {
                  for (const child of plugin) await flatten(child);
                } else if (plugin) flattened.push(plugin);
              };
              const pagesConfig = await vite.loadConfigFromFile(
                { command: "build", mode: "production", isSsrBuild: true },
                undefined,
                root,
              );
              await flatten(pagesConfig?.config.plugins ?? []);
              const transforms = flattened.filter(
                (plugin) =>
                  !plugin.name.startsWith("vinext:") &&
                  !plugin.name.startsWith("vite:react") &&
                  !plugin.name.startsWith("rsc:") &&
                  plugin.name !== "vite-rsc-load-module-dev-proxy" &&
                  !plugin.name.startsWith("vite-plugin-cloudflare"),
              );
              await vite.build({
                root,
                configFile: false,
                plugins: [
                  transforms,
                  vinext({ disableAppRouter: true }),
                  cache,
                ],
                resolve: {
                  dedupe: [
                    "react",
                    "react-dom",
                    "react/jsx-runtime",
                    "react/jsx-dev-runtime",
                  ],
                },
                build: {
                  outDir: "dist/server",
                  emptyOutDir: false,
                  ssr: "virtual:vinext-server-entry",
                  rolldownOptions: { output: { entryFileNames: "entry.js" } },
                },
              });
            }),
          );
          yield* runVinextPrerenderIfConfigured(root, options.cache, config);
        }),
      ({ previous, session }) =>
        Effect.sync(() => {
          if (session) clearPagesClientAssetsBuildMetadata(session);
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
  }).pipe(Effect.mapError(failFramework("Failed to build vinext")));

export const collectVinextDist = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const distDir = path.join(root, "dist");
    const serverDir = path.join(distDir, "server");
    const clientDir = path.join(distDir, "client");
    const rscEntry = path.join(distDir, VINEXT_RSC_ENTRY);
    const pagesEntry = path.join(distDir, VINEXT_PAGES_ENTRY);
    const hasDist = yield* fs
      .exists(distDir)
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasDist) {
      return yield* Effect.fail(
        failFramework(`The vinext build produced no ${distDir}`)(undefined),
      );
    }
    const hasRsc = yield* fs
      .exists(rscEntry)
      .pipe(Effect.orElseSucceed(() => false));
    const hasPages = yield* fs
      .exists(pagesEntry)
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasRsc && !hasPages) {
      return yield* Effect.fail(
        failFramework(
          `The vinext build produced no server entry at ${rscEntry} or ${pagesEntry}`,
        )(undefined),
      );
    }
    const hasClient = yield* fs
      .exists(clientDir)
      .pipe(Effect.orElseSucceed(() => false));
    yield* fs
      .writeFileString(
        path.join(serverDir, "package.json"),
        `${JSON.stringify({ type: "module" }, null, 2)}\n`,
      )
      .pipe(
        Effect.mapError(
          failFramework("Failed to write dist/server/package.json"),
        ),
      );
    return {
      distDirectory: distDir,
      clientDirectory: hasClient ? clientDir : undefined,
      serverDir,
      hasRsc,
      hasPages,
    };
  });

export const pinServeModule = (
  output: Omit<BuildOutput, "serverModules" | "externalWorkspaces"> & {
    readonly serverDir: string;
  },
  serveModuleName: string,
  serveSource: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const servePath = path.join(
      output.serverDir,
      path.basename(serveModuleName),
    );
    yield* fs
      .writeFileString(servePath, serveSource)
      .pipe(
        Effect.mapError(
          failFramework(`Failed to write the serve entry at ${servePath}`),
        ),
      );
    const serveModule = yield* toOutputFile(serveModuleName, serveSource);
    return {
      distDirectory: output.distDirectory,
      clientDirectory: output.clientDirectory,
      serverModules: [serveModule],
      externalWorkspaces: new Set<string>(),
    } satisfies BuildOutput;
  });

export interface VinextDevChild {
  readonly exited: () => boolean;
  readonly output: () => string;
}

export const spawnVinextDev = (options: {
  readonly root: string;
  readonly cli: string;
  readonly port: number;
  readonly host?: string | undefined;
}): Effect.Effect<VinextDevChild, FrameworkCore.FrameworkError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const cp = createRequire(import.meta.url)(
          "child_process",
        ) as typeof NodeChildProcessModule;
        const child = cp.spawn(
          "node",
          [
            options.cli,
            "dev",
            "-p",
            String(options.port),
            ...(options.host !== undefined ? ["-H", options.host] : []),
          ],
          {
            cwd: options.root,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
          },
        );
        let exited = false;
        let output = "";
        const capture = (chunk: unknown) => {
          output += String(chunk);
          if (output.length > 65536) output = output.slice(-32768);
          process.stderr.write(String(chunk));
        };
        child.stdout?.on("data", capture);
        child.stderr?.on("data", capture);
        child.once("exit", () => {
          exited = true;
        });
        return {
          child,
          handle: {
            exited: () => exited,
            output: () => output,
          } satisfies VinextDevChild,
        };
      },
      catch: failFramework(
        "Failed to spawn the vinext dev CLI (is `node` on PATH?)",
      ),
    }),
    ({ child }) =>
      Effect.callback<void>((resume) => {
        if (child.exitCode !== null) {
          resume(Effect.void);
          return;
        }
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          resume(Effect.void);
        });
        child.kill("SIGTERM");
      }),
  ).pipe(Effect.map(({ handle }) => handle));

/**
 * Poll until the allocated port accepts a TCP connection. vinext/Vite can
 * bind before the first App Router compile finishes, so an HTTP GET with
 * a short abort restarts that compile and never converges.
 */
export const awaitVinextDevReady = (options: {
  readonly url: string;
  readonly child: VinextDevChild;
}): Effect.Effect<void, FrameworkCore.FrameworkError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => new URL(options.url),
      catch: failFramework(`Invalid vinext dev URL: ${options.url}`),
    });
    const port = Number(parsed.port);
    const hostname = parsed.hostname;
    for (let attempt = 0; attempt < 240; attempt++) {
      if (options.child.exited()) {
        return yield* Effect.fail(
          failFramework(
            `The vinext dev CLI exited before becoming ready:\n${options.child.output().slice(-4000)}`,
          )(undefined),
        );
      }
      const ready = yield* Effect.callback<boolean>((resume) => {
        const net = createRequire(import.meta.url)("net") as typeof NodeNet;
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          resume(Effect.succeed(value));
        };
        const socket = net.connect({ host: hostname, port }, () => {
          socket.destroy();
          finish(true);
        });
        socket.setTimeout(2000, () => {
          socket.destroy();
          finish(false);
        });
        socket.once("error", () => {
          socket.destroy();
          finish(false);
        });
        return Effect.sync(() => {
          settled = true;
          socket.destroy();
        });
      });
      if (ready) return;
      yield* Effect.sleep(500);
    }
    return yield* Effect.fail(
      failFramework(
        `Timed out waiting for the vinext dev server at ${options.url}`,
      )(undefined),
    );
  });

export const pickEphemeralPort: Effect.Effect<
  number,
  FrameworkCore.FrameworkError
> = findEphemeralPort();
