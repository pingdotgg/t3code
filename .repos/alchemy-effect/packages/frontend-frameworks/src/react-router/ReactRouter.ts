import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as FrameworkCore from "../core/index.ts";
import {
  Framework,
  FrameworkError,
  type DeployTarget,
  type DeployTargetInput,
} from "../core/index.ts";

/**
 * The structural slice of the project's `vite` module this package drives.
 * Typed structurally so the package carries no dependency on vite — the
 * *project's* install is always the one loaded.
 *
 * `build` (not `createBuilder`) is the entry point: React Router v7's
 * `@react-router/dev` plugin drives a two-pass build — `vite build` for the
 * `client` environment, then `vite build` with `build.ssr` for the server
 * environment — which is exactly what `react-router build` runs. (The
 * Vite Environment API path exists only behind the framework's
 * `future.v8_viteEnvironmentApi` flag and for RSC; see the module doc on
 * {@link make}.)
 */
export interface ReactRouterViteModule {
  readonly version?: string;
  readonly build: (config: Record<string, unknown>) => Promise<unknown>;
  readonly createServer: (
    config: Record<string, unknown>,
  ) => Promise<ReactRouterViteDevServer>;
}

/** The structural slice of a Vite dev server this package reads. */
export interface ReactRouterViteDevServer {
  readonly listen: () => Promise<unknown>;
  readonly close: () => Promise<void>;
  readonly resolvedUrls?:
    | { readonly local: ReadonlyArray<string> }
    | null
    | undefined;
}

/** The slice of a resolved Vite config the output-directory capture reads. */
export interface ResolvedViteBuildSlice {
  readonly root: string;
  readonly build: { readonly outDir: string };
}

/**
 * The configuration this package assembles from {@link ReactRouterOptions}
 * and hands to a deploy-target factory. The target treats it as its
 * `DeployTarget.config`; the framework half never inspects a resolved
 * target's config.
 */
export interface ReactRouterTargetConfig {
  /**
   * Build output directory relative to the project root — the parent of
   * `client/` and `server/`. Mirrors `react-router.config.ts`'s
   * `buildDirectory`, and is only a FALLBACK: the integration prefers the
   * directories it observes on the resolved Vite config.
   * @default "build"
   */
  readonly buildDirectory?: string | undefined;
}

/**
 * A deploy target for React Router: the generic `DeployTarget` seams plus
 * the one framework-specific hook the build needs — the file name of the
 * server entry the server build emits, which the target's finishing pass
 * wraps.
 */
export interface ReactRouterTarget extends DeployTarget<ReactRouterTargetConfig> {
  /**
   * The server entry file name within the server output directory. React
   * Router names it after `react-router.config.ts`'s `serverBuildFile`
   * (default `index.js`). Omitted targets fall back to
   * {@link DEFAULT_SERVER_BUILD_FILE}, and a build that emits exactly one
   * top-level module under the server directory uses that instead when the
   * expected name is absent.
   */
  readonly serverEntryFileName?: string | undefined;
}

/**
 * How a deploy target is passed to this package: a `ReactRouterTarget`
 * value, a factory `(config) => ReactRouterTarget`, or a module specifier
 * resolved from the *project's* `node_modules`.
 */
export type ReactRouterTargetInput = DeployTargetInput<
  ReactRouterTarget,
  ReactRouterTargetConfig
>;

/**
 * The default deploy target: this package's own AWS Lambda target module,
 * loaded from the project's dependency tree. (Cloudflare deploys React
 * Router through its native Vite integration — `Cloudflare.Website.Vite` —
 * so no Cloudflare target exists here.)
 */
export const DEFAULT_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/react-router/aws";

/** The Vite plugin package a React Router project must install. */
export const REACT_ROUTER_PLUGIN_SPECIFIER = "@react-router/dev";

/** The default root output directory (the parent of `client/` and `server/`). */
export const DEFAULT_BUILD_DIRECTORY = "build";

/** The default server entry file name inside the server output directory. */
export const DEFAULT_SERVER_BUILD_FILE = "index.js";

/**
 * React Router's own virtual module holding the compiled server build — the
 * `ServerBuild` manifest (`{ entry, routes, assets, basename, ... }`), NOT a
 * request handler.
 */
export const REACT_ROUTER_SERVER_BUILD_ID = "virtual:react-router/server-build";

/**
 * The virtual module this integration makes the server build's rollup input:
 * it turns the `ServerBuild` manifest into a web-standard fetch handler.
 */
export const SERVER_ENTRY_ID = "virtual:alchemy/react-router-server-entry";

/** Rollup's convention for a plugin-owned virtual module id. */
const RESOLVED_SERVER_ENTRY_ID = `\0${SERVER_ENTRY_ID}`;

export interface ReactRouterOptions {
  /**
   * Project root (the directory containing `vite.config.*`).
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * The deploy target the build is produced for. Accepts a target value, a
   * `(config) => target` factory, or a module specifier string.
   * @default "@alchemy.run/frontend-frameworks/react-router/aws"
   */
  readonly target?: ReactRouterTargetInput | undefined;
  /**
   * Build output directory relative to the project root — the parent of
   * `client/` and `server/`. Mirrors `react-router.config.ts`'s
   * `buildDirectory`; used only as a fallback when the resolved Vite config
   * could not be observed.
   * @default "build"
   */
  readonly buildDirectory?: string | undefined;
  readonly dev?:
    | {
        /** Default dev-server port (overridden by `FrameworkDevOptions.port`). */
        readonly port?: number | undefined;
      }
    | undefined;
}

const fail = (message: string, cause?: unknown) =>
  new FrameworkError({ framework: "react-router", message, cause });

/**
 * The source of the virtual server entry ({@link SERVER_ENTRY_ID}).
 *
 * React Router's server build is a manifest, not a handler: it has no
 * default export and nothing to call. `createRequestHandler` from
 * `react-router` turns it into `(request) => Promise<Response>`, and this
 * module exposes that as the `{ fetch }` shape every deploy target's
 * finishing pass already knows how to wrap.
 *
 * This wrapping happens at BUILD time (as the server build's rollup input)
 * rather than as a file emitted afterwards, because `react-router` itself
 * must be part of the emitted bundle — the deployed server directory ships
 * without a `node_modules` tree.
 */
export const serverEntrySource = (mode: string = "production"): string =>
  `// Auto-generated by @alchemy.run/frontend-frameworks/react-router — do not edit.
import * as build from "${REACT_ROUTER_SERVER_BUILD_ID}";
import { createRequestHandler } from "react-router";

const handleRequest = createRequestHandler(build, ${JSON.stringify(mode)});

export default {
  fetch(request) {
    return handleRequest(request);
  },
};
`;

/** The structural slice of a Vite plugin this integration constructs. */
export interface InlineVitePlugin {
  readonly name: string;
  readonly enforce?: "pre" | "post" | undefined;
  readonly resolveId?: ((id: string) => string | undefined) | undefined;
  readonly load?: ((id: string) => string | undefined) | undefined;
  readonly configResolved?:
    | ((config: ResolvedViteBuildSlice) => void)
    | undefined;
}

/**
 * The Vite plugin serving {@link SERVER_ENTRY_ID}. `enforce: "pre"` so the
 * virtual id resolves before any project plugin sees it.
 */
export const serverEntryPlugin = (options?: {
  readonly mode?: string | undefined;
}): InlineVitePlugin => ({
  name: "alchemy:react-router-server-entry",
  enforce: "pre",
  resolveId: (id) =>
    id === SERVER_ENTRY_ID ? RESOLVED_SERVER_ENTRY_ID : undefined,
  load: (id) =>
    id === RESOLVED_SERVER_ENTRY_ID
      ? serverEntrySource(options?.mode)
      : undefined,
});

/** A mutable slot the {@link captureOutDirPlugin} writes the resolved outDir into. */
export interface OutDirCapture {
  outDir?: string | undefined;
}

/**
 * The Vite plugin that observes the RESOLVED output directory of a build.
 *
 * React Router derives both output directories from `react-router.config.ts`
 * (`buildDirectory`), which is TypeScript the integration must not evaluate
 * itself. Reading them off the config Vite actually resolved is exact, free,
 * and honors every project override.
 */
export const captureOutDirPlugin = (
  capture: OutDirCapture,
): InlineVitePlugin => ({
  name: "alchemy:react-router-capture-outdir",
  enforce: "post",
  configResolved: (config) => {
    capture.outDir = config.build.outDir;
  },
});

/**
 * The inline config for the CLIENT pass, merged over the project's own
 * `vite.config.*` (which loads natively, plugins included).
 */
export const inlineClientBuildConfig = (
  root: string,
  plugins: ReadonlyArray<InlineVitePlugin>,
): Record<string, unknown> => ({
  root,
  mode: "production",
  // Warn-level: rolldown-vite's native progress reporter writes straight to
  // the fd, corrupting hosting-process reporters that can only intercept
  // JS-level writers.
  logLevel: "warn",
  plugins,
});

/**
 * The inline config for the SERVER pass.
 *
 * Two overrides carry the whole AWS story:
 *
 * - `build.ssr` selects React Router's server environment (the flag its
 *   plugin branches on), and `build.rollupOptions.input` replaces the
 *   framework's `virtual:react-router/server-build` input with the fetch
 *   handler wrapper ({@link serverEntrySource}) — the plugin honors a
 *   user-provided input verbatim.
 * - `noExternal` is load-bearing: Vite externalizes `node_modules` imports
 *   from SSR bundles by default, so a stock React Router server build emits
 *   `import { ServerRouter } from "react-router"` and is only runnable next
 *   to an installed dependency tree. A Lambda ships the server directory
 *   alone, so the bundle must be self-contained — only `node:` builtins
 *   stay external. Declared on both the legacy `ssr` key and the
 *   environment key so it holds across Vite majors.
 */
export const inlineServerBuildConfig = (
  root: string,
  plugins: ReadonlyArray<InlineVitePlugin>,
): Record<string, unknown> => ({
  root,
  mode: "production",
  logLevel: "warn",
  build: {
    ssr: true,
    rollupOptions: { input: SERVER_ENTRY_ID },
  },
  ssr: { noExternal: true },
  environments: { ssr: { resolve: { noExternal: true } } },
  plugins,
});

/**
 * Build the `Framework` service implementation for a React Router v7
 * project (framework mode).
 *
 * - `build` resolves the deploy target, then either delegates wholesale
 *   (`target.build`) or drives the PROJECT's own Vite install
 *   programmatically, mirroring what `react-router build` does: the client
 *   pass first (it writes the asset manifest the server pass reads), then
 *   the server pass with `build.ssr`. `reactRouter()` in the project's
 *   `vite.config.ts` owns routing, typegen, and both environments — there
 *   is no adapter to select and no plugin to inject beyond the fetch-handler
 *   entry ({@link serverEntrySource}) and the self-contained SSR bundle
 *   ({@link inlineServerBuildConfig}). The `BuildOutput` is read from disk:
 *   `serverModules` entry-first from the server directory,
 *   `clientDirectory` = the client directory, both observed off the
 *   resolved Vite config.
 * - `dev` runs the project's own Vite dev server (React Router's plugin
 *   serves SSR, resource routes, and typegen through it with native HMR),
 *   scoped — closing the Scope closes the server.
 *
 * NOT supported: React Server Components / multi-environment builds (React
 * Router's `unstable` RSC plugin, or `future.v8_viteEnvironmentApi`). Those
 * emit more than one server environment, which this two-pass build does not
 * assemble; the build fails with an actionable error when no single server
 * entry is produced.
 *
 * This module is target-agnostic: everything AWS-specific lives in
 * `@alchemy.run/frontend-frameworks/react-router/aws`.
 */
export const make: (
  options?: ReactRouterOptions,
) => Effect.Effect<
  Framework["Service"],
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (options?: ReactRouterOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseRoot = options?.root ?? (yield* Effect.sync(() => process.cwd()));

  const targetConfig: ReactRouterTargetConfig = {
    buildDirectory: options?.buildDirectory,
  };

  const resolveTarget = (root: string) =>
    FrameworkCore.resolveDeployTarget<
      ReactRouterTarget,
      ReactRouterTargetConfig
    >(root, options?.target ?? DEFAULT_TARGET_SPECIFIER, targetConfig).pipe(
      Effect.mapError((error) => fail(error.message, error.cause)),
    );

  const loadVite = (root: string) =>
    FrameworkCore.loadProjectModule<ReactRouterViteModule>(root, "vite").pipe(
      Effect.mapError((error) =>
        fail("Failed to load the project's Vite install", error.cause),
      ),
    );

  const removeViteManifests = (directories: ReadonlyArray<string>) =>
    Effect.forEach(directories, (directory) =>
      fs
        .remove(path.join(directory, ".vite"), { recursive: true })
        .pipe(Effect.ignore),
    );

  const build: Framework["Service"]["build"] = Effect.fn(
    function* (buildOptions) {
      const root = buildOptions?.root ?? baseRoot;
      const target = yield* resolveTarget(root);
      const targetContext = {
        root,
        framework: "react-router",
        env: buildOptions?.env,
      };

      // Wholesale build takeover (the AWS target uses this seam to run the
      // build in a disposable child process — vite.config.* executes user
      // plugins that must not touch the engine process, and React Router's
      // config loader resolves `react-router.config.ts` from the cwd).
      if (target.build !== undefined) {
        return yield* target.build(targetContext).pipe(
          Effect.mapError((error) => fail(error.message, error.cause)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }

      const vite = yield* loadVite(root);
      const clientCapture: OutDirCapture = {};
      const serverCapture: OutDirCapture = {};

      yield* Effect.tryPromise({
        try: () =>
          vite.build(
            inlineClientBuildConfig(root, [captureOutDirPlugin(clientCapture)]),
          ),
        catch: (error) => fail("Failed to build the client", error),
      });
      yield* Effect.tryPromise({
        try: () =>
          vite.build(
            inlineServerBuildConfig(root, [
              serverEntryPlugin(),
              captureOutDirPlugin(serverCapture),
            ]),
          ),
        catch: (error) => fail("Failed to build the server", error),
      });

      const fallbackDir = path.resolve(
        root,
        options?.buildDirectory ?? DEFAULT_BUILD_DIRECTORY,
      );
      const clientDir =
        clientCapture.outDir !== undefined
          ? path.resolve(root, clientCapture.outDir)
          : path.join(fallbackDir, "client");
      const serverDir =
        serverCapture.outDir !== undefined
          ? path.resolve(root, serverCapture.outDir)
          : path.join(fallbackDir, "server");

      // `react-router build` deletes the per-environment Vite manifests once
      // the server pass has consumed the client one; ours would otherwise
      // ship to the CDN as a public `/.vite/manifest.json`.
      yield* removeViteManifests([clientDir, serverDir]);

      const output = yield* readReactRouterOutput({
        dir: path.dirname(serverDir),
        serverDir,
        clientDir,
        serverEntryFileName: target.serverEntryFileName,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));

      const entryName = output.serverModules?.[0]?.name;
      return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
        ...targetContext,
        ...(entryName !== undefined
          ? { entry: path.join(output.distDirectory ?? root, entryName) }
          : undefined),
      }).pipe(
        Effect.mapError((error) => fail(error.message, error.cause)),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    },
  );

  const dev: Framework["Service"]["dev"] = Effect.fn(function* (devOptions) {
    const root = devOptions?.root ?? baseRoot;
    const vite = yield* loadVite(root);
    // `port: 0` (true OS-assigned) on Vite >= 8.2.1, probed ephemeral port
    // on older Vite — see `resolveViteDevPort`.
    const port = yield* FrameworkCore.resolveViteDevPort(
      vite.version,
      devOptions?.port ?? options?.dev?.port,
    );
    const host = devOptions?.host;

    const server = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const server = await vite.createServer({
            root,
            logLevel: "warn",
            server: {
              port,
              ...(host !== undefined ? { host } : undefined),
            },
          });
          await server.listen();
          return server;
        },
        catch: (error) =>
          fail("Failed to start the React Router dev server", error),
      }),
      (server) =>
        Effect.promise(async () => {
          try {
            await server.close();
          } catch {
            // teardown is best-effort
          }
        }),
    );

    const resolved = server.resolvedUrls?.local[0];
    if (resolved === undefined) {
      return yield* Effect.fail(fail("Could not determine the dev server URL"));
    }
    // Vite reports its local URL with a trailing slash; hand back an origin
    // that concatenates correctly (`${url}/about`, not `//about`).
    const url = resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;

    // Bounded readiness probe: any HTTP response counts (vite serves
    // lazily; we only need the listener to answer).
    yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, { redirect: "manual" });
        await response.arrayBuffer().catch(() => {});
      },
      catch: (error) => fail("The dev server did not become reachable", error),
    }).pipe(
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
    );

    return { url };
  });

  return Framework.of({ build, dev });
});

/** The resolved React Router build output directories. */
export interface ReactRouterOutputDirs {
  /** Root output directory (`<root>/build`) — the parent of both. */
  readonly dir: string;
  /** Server bundle directory (`<root>/build/server`). */
  readonly serverDir: string;
  /** Client assets directory (`<root>/build/client`), `public/` copied in. */
  readonly clientDir: string;
  /**
   * The emitted server entry file name within `serverDir`.
   * @default "index.js"
   */
  readonly serverEntryFileName?: string | undefined;
}

/**
 * Pick the server entry among the modules read off disk.
 *
 * The expected name wins. Otherwise, a build whose server directory holds
 * exactly one top-level module (chunks live under `assets/`) is
 * unambiguous — that module is the entry, which covers a project that sets
 * `serverBuildFile` to something other than `index.js`.
 */
export const selectServerEntryName = (
  moduleNames: ReadonlyArray<string>,
  expected: string,
): string | undefined => {
  if (moduleNames.includes(expected)) return expected;
  const topLevel = moduleNames.filter(
    (name) =>
      !name.slice("server/".length).includes("/") &&
      (name.endsWith(".js") || name.endsWith(".mjs")),
  );
  return topLevel.length === 1 ? topLevel[0] : undefined;
};

/**
 * Map React Router's on-disk build tree onto the `BuildOutput` contract:
 * `serverModules` entry-first from `<buildDirectory>/server` (POSIX names,
 * sha256-hashed), `clientDirectory` = `<buildDirectory>/client`. The server
 * bundle is built with `noExternal`, so it is self-contained (only `node:`
 * builtins external) and there are no external workspace roots to watch.
 */
export const readReactRouterOutput = (
  dirs: ReactRouterOutputDirs,
): Effect.Effect<
  FrameworkCore.BuildOutput,
  FrameworkError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const expected = `server/${dirs.serverEntryFileName ?? DEFAULT_SERVER_BUILD_FILE}`;
    const modules = yield* FrameworkCore.readServerModulesFromDisk({
      directory: dirs.serverDir,
      prefix: "server",
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause)));
    if (modules.length === 0) {
      return yield* Effect.fail(
        fail(
          `The React Router build produced no server modules in ${dirs.serverDir}`,
        ),
      );
    }
    const entryName = selectServerEntryName(
      modules.map((module) => module.name),
      expected,
    );
    if (entryName === undefined) {
      return yield* Effect.fail(
        fail(
          `The React Router build produced no "${expected}" entry in ${dirs.serverDir} — ` +
            "React Server Components and multi-environment builds are not supported yet.",
        ),
      );
    }
    return {
      distDirectory: dirs.dir,
      clientDirectory: dirs.clientDir,
      serverModules: FrameworkCore.sortServerModules(modules, entryName),
      externalWorkspaces: new Set<string>(),
    } satisfies FrameworkCore.BuildOutput;
  });

/**
 * A `Layer` providing framework-core's `Framework` service for a React
 * Router project — the fully-typed entrypoint for `e2e.config.ts` and
 * alchemy's `AWS.Website.ReactRouter` composite.
 */
export const layer = (
  options?: ReactRouterOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Framework, make(options));
