import * as FrameworkCore from "../core/index.ts";
import {
  Framework,
  FrameworkError,
  type DeployTarget,
  type DeployTargetInput,
} from "../core/index.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

/**
 * The structural slice of the project's `@octanejs/vite-plugin` module this
 * package drives. Typed structurally so the package carries no dependency on
 * `@octanejs/vite-plugin` — the *project's* install is always the one loaded.
 */
export interface OctaneVitePluginModule {
  /**
   * Load and resolve the project's `octane.config.ts` (spins a temporary
   * Vite module runner internally when no dev server is supplied, so `.tsrx`
   * imports in the config graph resolve).
   */
  readonly loadOctaneConfig: (
    projectRoot: string,
    options?: Record<string, unknown>,
  ) => Promise<ResolvedOctaneConfigSlice | null>;
}

/** The structural slice of a resolved `octane.config.ts` this package reads. */
export interface ResolvedOctaneConfigSlice {
  readonly router: { readonly routes: ReadonlyArray<unknown> };
  readonly build: { readonly outDir: string };
  readonly adapter?:
    | {
        readonly name?: string | undefined;
        readonly serverTarget?: string | undefined;
      }
    | undefined;
}

/** The structural slice of the project's `vite` module this package drives. */
export interface OctaneViteModule {
  readonly version?: string;
  readonly build: (config: Record<string, unknown>) => Promise<unknown>;
  readonly createServer: (
    config: Record<string, unknown>,
  ) => Promise<OctaneViteDevServer>;
}

/** The structural slice of a Vite dev server this package reads. */
export interface OctaneViteDevServer {
  readonly listen: () => Promise<unknown>;
  readonly close: () => Promise<void>;
  readonly resolvedUrls?:
    | { readonly local: ReadonlyArray<string> }
    | null
    | undefined;
}

/**
 * The configuration this package assembles from {@link OctaneOptions} and
 * hands to a deploy-target factory. The target treats it as its
 * `DeployTarget.config`; the framework half never inspects a resolved
 * target's config.
 */
export interface OctaneTargetConfig {
  /** Compatibility date the target carries for serve/deploy. */
  readonly compatibilityDate?: string | undefined;
  /** Compatibility flags the target carries for serve/deploy. */
  readonly compatibilityFlags?: Array<string> | undefined;
}

/**
 * A deploy target for Octane: the generic `DeployTarget` seams plus the one
 * framework-specific hook an Octane build needs — which Octane deploy adapter
 * the project's `octane.config.ts` must select. Octane's own build pipeline
 * (`vite build` with `@octanejs/vite-plugin`) already produces the final
 * platform output through that adapter, so the target neither injects
 * bundler plugins nor post-processes the build.
 */
export interface OctaneTarget extends DeployTarget<OctaneTargetConfig> {
  /**
   * The `adapter.name` the resolved `octane.config.ts` must carry (the
   * Cloudflare target requires `"cloudflare"` — Octane's
   * `@octanejs/adapter-cloudflare`).
   */
  readonly adapterName: string;
  /**
   * The npm package providing that adapter — used in the actionable error
   * when the project's config selects no (or a foreign) adapter.
   */
  readonly adapterPackage: string;
  /**
   * The Worker entry module the adapter emits, relative to the build's
   * server output directory (Cloudflare: `worker.js`).
   */
  readonly serverEntryFileName: string;
}

/**
 * How a deploy target is passed to this package: an `OctaneTarget` value, a
 * factory `(config) => OctaneTarget`, or a module specifier resolved from the
 * *project's* `node_modules` (default-export — or named export `target` — a
 * value or factory).
 */
export type OctaneTargetInput = DeployTargetInput<
  OctaneTarget,
  OctaneTargetConfig
>;

/**
 * The default deploy target: this package's own Cloudflare Workers target
 * module (`src/cloudflare.ts`), loaded from the project's dependency tree.
 */
export const DEFAULT_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/octane/cloudflare";

/** The specifier the project's Octane Vite integration is loaded from. */
export const OCTANE_VITE_PLUGIN_SPECIFIER = "@octanejs/vite-plugin";

export interface OctaneOptions {
  /**
   * Project root (the directory containing `vite.config.ts` and
   * `octane.config.ts`).
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * The deploy target the build is produced for. Accepts a target value, a
   * `(config) => target` factory, or a module specifier string.
   * @default "@alchemy.run/frontend-frameworks/octane/cloudflare"
   */
  readonly target?: OctaneTargetInput | undefined;
  /** Compatibility date forwarded to the target via its config. */
  readonly compatibilityDate?: string | undefined;
  /**
   * Compatibility flags forwarded to the target via its config. Octane's
   * server runtime needs synchronous SHA-256 and `AsyncLocalStorage`, so on
   * workerd-style targets `nodejs_compat` is effectively required.
   */
  readonly compatibilityFlags?: Array<string> | undefined;
  readonly dev?:
    | {
        /** Default dev-server port (overridden by `FrameworkDevOptions.port`). */
        readonly port?: number | undefined;
      }
    | undefined;
}

const fail = (message: string, cause?: unknown) =>
  new FrameworkError({ framework: "octane", message, cause });

/**
 * Build the `Framework` service implementation for an Octane project.
 *
 * - `build` resolves the deploy target, then drives the PROJECT's own Vite
 *   install programmatically: Octane's `vite build` is the whole pipeline —
 *   `@octanejs/vite-plugin` builds the client bundle, launches the `ssr:
 *   true` server sub-build, and runs the config's deploy adapter, which
 *   emits the platform Worker entry (Cloudflare:
 *   `dist/server/worker.js`, self-contained ESM with only `node:`
 *   externals). The `BuildOutput` is then read from disk: `serverModules`
 *   entry-first from `<outDir>/server`, `clientDirectory` =
 *   `<outDir>/client`. The project's `octane.config.ts` must select the
 *   target's adapter (`adapter: cloudflare()`), mirroring Octane's own
 *   deployment story — a missing or foreign adapter fails with an
 *   actionable error.
 * - `dev` runs Octane's own Vite dev server programmatically (the plugin's
 *   dev SSR middleware serves rendering, server routes, and RPC in-process),
 *   scoped — closing the Scope closes the server. NOTE: Octane's dev
 *   middleware does not supply request-scoped platform bindings
 *   (`context.platform` is `undefined` in dev — an upstream limitation), so
 *   Cloudflare bindings are live/preview-only for now.
 *
 * This module is target-agnostic: everything Cloudflare-specific lives in
 * `@alchemy.run/frontend-frameworks/octane/cloudflare`.
 */
export const make: (
  options?: OctaneOptions,
) => Effect.Effect<
  Framework["Service"],
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (options?: OctaneOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseRoot = options?.root ?? (yield* Effect.sync(() => process.cwd()));

  const targetConfig: OctaneTargetConfig = {
    compatibilityDate: options?.compatibilityDate,
    compatibilityFlags: options?.compatibilityFlags,
  };

  const resolveTarget = (root: string) =>
    FrameworkCore.resolveDeployTarget<OctaneTarget, OctaneTargetConfig>(
      root,
      options?.target ?? DEFAULT_TARGET_SPECIFIER,
      targetConfig,
    ).pipe(Effect.mapError((error) => fail(error.message, error.cause)));

  const loadVite = (root: string) =>
    FrameworkCore.loadProjectModule<OctaneViteModule>(root, "vite").pipe(
      Effect.mapError((error) =>
        fail("Failed to load the project's Vite install", error.cause),
      ),
    );

  const loadOctanePlugin = (root: string) =>
    FrameworkCore.loadProjectModule<OctaneVitePluginModule>(
      root,
      OCTANE_VITE_PLUGIN_SPECIFIER,
    ).pipe(
      Effect.mapError((error) =>
        fail(
          `Failed to load the project's "${OCTANE_VITE_PLUGIN_SPECIFIER}" install — ` +
            "is it added to the project's dependencies?",
          error.cause,
        ),
      ),
    );

  const build: Framework["Service"]["build"] = Effect.fn(
    function* (buildOptions) {
      const root = buildOptions?.root ?? baseRoot;
      const target = yield* resolveTarget(root);
      const targetContext = {
        root,
        framework: "octane",
        env: buildOptions?.env,
      };

      // Wholesale build takeover (targets that own the entire pipeline).
      if (target.build !== undefined) {
        return yield* target.build(targetContext).pipe(
          Effect.mapError((error) => fail(error.message, error.cause)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }

      const octanePlugin = yield* loadOctanePlugin(root);
      const config = yield* Effect.tryPromise({
        try: async () => await octanePlugin.loadOctaneConfig(root),
        catch: (error) =>
          fail("Failed to load the project's octane.config.ts", error),
      });
      if (config === null || config.router.routes.length === 0) {
        return yield* Effect.fail(
          fail(
            "The project has no octane.config.ts routes. A fullstack Octane app " +
              "(routes + SSR) is required here; a client-only Octane SPA deploys " +
              "through the plain Vite integration instead.",
          ),
        );
      }
      if (config.adapter?.name !== target.adapterName) {
        return yield* Effect.fail(
          fail(
            config.adapter?.name === undefined
              ? `octane.config.ts selects no deploy adapter. Add the "${target.platform}" ` +
                  `adapter from ${target.adapterPackage}, e.g. ` +
                  `\`import { ${target.adapterName} } from "${target.adapterPackage}"\` ` +
                  `and \`adapter: ${target.adapterName}()\`.`
              : `octane.config.ts selects the "${config.adapter.name}" deploy adapter, but ` +
                  `this build targets "${target.platform}" — use the "${target.adapterName}" ` +
                  `adapter from ${target.adapterPackage} instead.`,
          ),
        );
      }

      // Octane's plugin (from the project's own vite.config.ts) drives the
      // entire production pipeline inside this one call: client build,
      // `ssr: true` server sub-build, and the adapter's adapt() pass.
      const vite = yield* loadVite(root);
      yield* Effect.tryPromise({
        try: async () => await vite.build({ root, logLevel: "warn" }),
        catch: (error) => fail("Failed to build", error),
      });

      const outDir = path.resolve(root, config.build.outDir);
      const output = yield* readOctaneOutput({
        dir: outDir,
        serverDir: path.join(outDir, "server"),
        clientDir: path.join(outDir, "client"),
        serverEntryFileName: target.serverEntryFileName,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));

      // The finishing-pass seam (none needed for Cloudflare — the adapter's
      // worker.js is already self-contained workerd ESM — but the contract
      // is honored for targets that do post-process).
      return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
        ...targetContext,
        entry: path.join(outDir, "server", target.serverEntryFileName),
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
            server: {
              port,
              ...(host !== undefined ? { host } : undefined),
            },
          });
          await server.listen();
          return server;
        },
        catch: (error) => fail("Failed to start the Octane dev server", error),
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

    const url = server.resolvedUrls?.local[0];
    if (url === undefined) {
      return yield* Effect.fail(fail("Could not determine the dev server URL"));
    }

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

/**
 * Build-output files under `<outDir>/server` that are inputs to the
 * adapter's adapt() pass rather than runtime Worker modules: the SSR HTML
 * template and Rsbuild's late client asset map are both EMBEDDED into the
 * generated `worker.js`, so uploading them as Worker modules would be
 * redundant (and `.html` is not a valid Worker module type).
 */
const NON_MODULE_SERVER_FILES = new Set([
  "index.html",
  "octane-client-assets.json",
]);

/** The resolved Octane build output directories. */
export interface OctaneOutputDirs {
  /** Root output directory (`<root>/dist`). */
  readonly dir: string;
  /** Server bundle directory (`<root>/dist/server`). */
  readonly serverDir: string;
  /** Static assets directory (`<root>/dist/client`). */
  readonly clientDir: string;
  /**
   * The adapter-emitted Worker entry file name within `serverDir`.
   * @default "worker.js"
   */
  readonly serverEntryFileName?: string | undefined;
}

/**
 * Map Octane's on-disk `dist` onto the `BuildOutput` contract:
 * `serverModules` entry-first from the server directory (POSIX names,
 * sha256-hashed, excluding the embedded-template inputs), `clientDirectory`
 * = the client directory. The adapter's server output is already
 * self-contained ESM (only `node:` externals) — no finishing pass, and no
 * external workspace roots (the server sub-build bundles with
 * `noExternal: true`, so workspace imports are inlined).
 */
export const readOctaneOutput = (
  dirs: OctaneOutputDirs,
): Effect.Effect<
  FrameworkCore.BuildOutput,
  FrameworkError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const entryFileName = dirs.serverEntryFileName ?? "worker.js";
    const entryName = `server/${entryFileName}`;
    const modules = yield* FrameworkCore.readServerModulesFromDisk({
      directory: dirs.serverDir,
      prefix: "server",
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause)));
    const serverModules = FrameworkCore.sortServerModules(
      modules.filter(
        (module) =>
          !NON_MODULE_SERVER_FILES.has(module.name.slice("server/".length)),
      ),
      entryName,
    );
    if (serverModules.length === 0) {
      return yield* Effect.fail(
        fail(
          `The Octane build produced no server modules in ${dirs.serverDir}`,
        ),
      );
    }
    if (serverModules[0]?.name !== entryName) {
      return yield* Effect.fail(
        fail(
          `The Octane build produced no "${entryName}" entry in ${dirs.serverDir} — ` +
            "did the deploy adapter's adapt() pass run?",
        ),
      );
    }
    return {
      distDirectory: dirs.dir,
      clientDirectory: dirs.clientDir,
      serverModules,
      externalWorkspaces: new Set<string>(),
    } satisfies FrameworkCore.BuildOutput;
  });

/**
 * A `Layer` providing framework-core's `Framework` service for an Octane
 * project — the fully-typed entrypoint for `e2e.config.ts` (harness form 4)
 * and alchemy's `Website.Octane` composite.
 */
export const layer = (
  options?: OctaneOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Framework, make(options));
