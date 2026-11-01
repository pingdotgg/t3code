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

/** The structural slice of the project's `vite` module this package drives. */
export interface ViteModule {
  readonly version?: string;
  readonly build: (config: Record<string, unknown>) => Promise<unknown>;
  readonly createServer: (
    config: Record<string, unknown>,
  ) => Promise<ViteDevServer>;
  /**
   * `vite.resolveConfig` — used to read the project's resolved `build.outDir`
   * (and root) without duplicating vite's config-file discovery. Optional in
   * the slice: ancient vite versions without it fall back to `dist`.
   */
  readonly resolveConfig?: (
    config: Record<string, unknown>,
    command: "build" | "serve",
  ) => Promise<ResolvedViteConfigSlice>;
}

/** The structural slice of a resolved vite config this package reads. */
export interface ResolvedViteConfigSlice {
  readonly root: string;
  readonly build: { readonly outDir: string };
}

/** The structural slice of a Vite dev server this package reads. */
export interface ViteDevServer {
  readonly listen: () => Promise<unknown>;
  readonly close: () => Promise<void>;
  /**
   * Native Node HTTP server. `null` in middleware mode; optional so older
   * vite slices without the field still typecheck.
   */
  readonly httpServer?:
    | { readonly closeAllConnections?: () => void }
    | null
    | undefined;
  readonly resolvedUrls?:
    | { readonly local: ReadonlyArray<string> }
    | null
    | undefined;
}

/**
 * Serializable build knobs merged OVER the project's own `vite.config.*`
 * (which loads natively, plugins included).
 */
export interface ViteBuildConfig {
  /**
   * Build output directory, relative to the project root. Overrides the
   * project config's `build.outDir`.
   * @default the project config's `build.outDir` (vite's default: "dist")
   */
  readonly outDir?: string | undefined;
  /** Public base path the site deploys under (vite's `base`). */
  readonly base?: string | undefined;
  /**
   * Alternate config file to load instead of the auto-discovered
   * `vite.config.*`, resolved relative to the project root.
   */
  readonly configFile?: string | undefined;
}

/**
 * The configuration this package assembles from {@link ViteOptions} and
 * hands to a deploy-target factory (the target's `config`). Framework-core
 * never inspects it.
 */
export interface ViteTargetConfig {
  readonly vite?: ViteBuildConfig | undefined;
  /**
   * Assets-only Node serve entry (`vite/node` finish). `"spa"` serves
   * `index.html` for unmatched GET paths.
   * @default "spa" on the Node target
   */
  readonly notFoundHandling?: "none" | "spa" | "404-page" | undefined;
  /**
   * Serve `about/index.html` at `/about`.
   * @default "none"
   */
  readonly htmlHandling?: "none" | "drop-trailing-slash" | undefined;
}

/**
 * A deploy target for plain Vite: just the generic `DeployTarget` seams.
 * A client-only Vite build has no server output, so targets have nothing
 * framework-specific to hook — the AWS target only uses the wholesale
 * `build` seam to move the build into a child process.
 */
export interface ViteTarget extends DeployTarget<ViteTargetConfig> {}

/** How a deploy target is passed to this package (value, factory, or specifier). */
export type ViteTargetInput = DeployTargetInput<ViteTarget, ViteTargetConfig>;

/**
 * The default deploy target: this package's AWS static-site target module,
 * loaded from the project's dependency tree. (Cloudflare deploys plain Vite
 * projects through its native Vite plugin — `Cloudflare.Website.Vite` —
 * so no Cloudflare target exists here.)
 */
export const DEFAULT_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vite/aws";

export interface ViteOptions {
  /**
   * Project root (the directory containing `vite.config.*` / `index.html`).
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * The deploy target the build is produced for. Accepts a target value, a
   * `(config) => target` factory, or a module specifier string.
   * @default "@alchemy.run/frontend-frameworks/vite/aws"
   */
  readonly target?: ViteTargetInput | undefined;
  /** Serializable overrides merged over the project's `vite.config.*`. */
  readonly vite?: ViteBuildConfig | undefined;
  /**
   * Forwarded to the Node target's static serve entry. Ignored by AWS
   * (S3) / Cloudflare (Workers assets).
   */
  readonly notFoundHandling?: "none" | "spa" | "404-page" | undefined;
  readonly htmlHandling?: "none" | "drop-trailing-slash" | undefined;
  readonly dev?:
    | {
        /** Default dev-server port (overridden by `FrameworkDevOptions.port`). */
        readonly port?: number | undefined;
      }
    | undefined;
}

const fail = (message: string, cause?: unknown) =>
  new FrameworkError({ framework: "vite", message, cause });

/**
 * Build the `Framework` service implementation for a plain Vite project —
 * a client-only site (React/Vue/Solid SPA, an `index.html` multi-page app,
 * a Foldkit app, ...) whose entire deployable output is static assets.
 *
 * - `build` resolves the deploy target, then drives the PROJECT's own Vite
 *   install programmatically: one `vite build` with the project's
 *   `vite.config.*` (plugins included) producing the assets directory. The
 *   `BuildOutput` is assets-only: `clientDirectory` = the resolved
 *   `build.outDir`, `serverModules: undefined`.
 * - `dev` runs the project's own Vite dev server programmatically (native
 *   HMR), scoped — closing the Scope closes the server.
 *
 * Frameworks that wrap Vite with a server half (Octane, SvelteKit, Astro,
 * ...) have their own integrations; Octane's fails actionably when pointed
 * at a fullstack config, and this one deliberately never looks for server
 * output.
 */
export const make: (
  options?: ViteOptions,
) => Effect.Effect<
  Framework["Service"],
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (options?: ViteOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseRoot = options?.root ?? (yield* Effect.sync(() => process.cwd()));

  const targetConfig: ViteTargetConfig = {
    vite: options?.vite,
    notFoundHandling: options?.notFoundHandling,
    htmlHandling: options?.htmlHandling,
  };

  const resolveTarget = (root: string) =>
    FrameworkCore.resolveDeployTarget<ViteTarget, ViteTargetConfig>(
      root,
      options?.target ?? DEFAULT_TARGET_SPECIFIER,
      targetConfig,
    ).pipe(Effect.mapError((error) => fail(error.message, error.cause)));

  const loadVite = (root: string) =>
    FrameworkCore.loadProjectModule<ViteModule>(root, "vite").pipe(
      Effect.mapError((error) =>
        fail("Failed to load the project's Vite install", error.cause),
      ),
    );

  /**
   * The inline config merged over the project's `vite.config.*` on both
   * `build` and `resolveConfig`, so the resolved `outDir` and the actual
   * build always agree.
   */
  const inlineConfig = (root: string): Record<string, unknown> => ({
    root,
    logLevel: "warn",
    // Resolve against the project root, not the cwd vite would use, so
    // "relative to rootDir" semantics hold regardless of where the engine
    // (or the build child) happens to run.
    ...(options?.vite?.configFile !== undefined
      ? { configFile: path.resolve(root, options.vite.configFile) }
      : undefined),
    ...(options?.vite?.base !== undefined
      ? { base: options.vite.base }
      : undefined),
    ...(options?.vite?.outDir !== undefined
      ? { build: { outDir: options.vite.outDir } }
      : undefined),
  });

  /** Resolve the absolute assets output directory for a build at `root`. */
  const resolveOutDir = (vite: ViteModule, root: string) =>
    Effect.gen(function* () {
      if (options?.vite?.outDir !== undefined) {
        return path.resolve(root, options.vite.outDir);
      }
      if (vite.resolveConfig === undefined) {
        return path.resolve(root, "dist");
      }
      const resolved = yield* Effect.tryPromise({
        try: async () =>
          await vite.resolveConfig!(
            { ...inlineConfig(root), logLevel: "error" },
            "build",
          ),
        catch: (error) =>
          fail("Failed to resolve the project's vite config", error),
      });
      return path.resolve(resolved.root ?? root, resolved.build.outDir);
    });

  const build: Framework["Service"]["build"] = Effect.fn(
    function* (buildOptions) {
      const root = buildOptions?.root ?? baseRoot;
      const target = yield* resolveTarget(root);
      const targetContext = { root, framework: "vite", env: buildOptions?.env };

      // Wholesale build takeover (the AWS target uses this seam to run the
      // build in a disposable child process — vite.config.* executes user
      // plugins that must not touch the engine process).
      if (target.build !== undefined) {
        return yield* target.build(targetContext).pipe(
          Effect.mapError((error) => fail(error.message, error.cause)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }

      const vite = yield* loadVite(root);
      yield* Effect.tryPromise({
        try: async () => await vite.build(inlineConfig(root)),
        catch: (error) => fail("Failed to build", error),
      });

      const outDir = yield* resolveOutDir(vite, root);
      const output = yield* readViteOutput({ outDir }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      return yield* FrameworkCore.applyDeployTargetFinish(
        target,
        output,
        targetContext,
      ).pipe(
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
            ...(options?.vite?.configFile !== undefined
              ? { configFile: path.resolve(root, options.vite.configFile) }
              : undefined),
            ...(options?.vite?.base !== undefined
              ? { base: options.vite.base }
              : undefined),
            server: {
              port,
              ...(host !== undefined ? { host } : undefined),
            },
          });
          await server.listen();
          return server;
        },
        catch: (error) => fail("Failed to start the Vite dev server", error),
      }),
      (server) =>
        Effect.promise(async () => {
          try {
            server.httpServer?.closeAllConnections?.();
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
 * Map a plain Vite build's on-disk output onto the `BuildOutput` contract:
 * assets-only — the whole `outDir` is the client directory, there are no
 * server modules, and no external workspace roots (vite bundles workspace
 * imports into the client assets).
 */
export const readViteOutput = (options: {
  /** Absolute assets output directory (the resolved `build.outDir`). */
  readonly outDir: string;
}): Effect.Effect<
  FrameworkCore.BuildOutput,
  FrameworkError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* Effect.orElseSucceed(
      fs.exists(options.outDir),
      () => false,
    );
    if (!exists) {
      return yield* Effect.fail(
        fail(
          `The Vite build produced no output directory at ${options.outDir}`,
        ),
      );
    }
    return {
      distDirectory: options.outDir,
      clientDirectory: options.outDir,
      serverModules: undefined,
      externalWorkspaces: new Set<string>(),
    } satisfies FrameworkCore.BuildOutput;
  });

/**
 * A `Layer` providing framework-core's `Framework` service for a plain Vite
 * project — the fully-typed entrypoint for `e2e.config.ts` and alchemy's
 * `AWS.Website.Vite` composite.
 */
export const layer = (
  options?: ViteOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Framework, make(options));
