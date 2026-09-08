import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as FrameworkCore from "../core/index.ts";
import {
  Framework,
  FrameworkError,
  type DeployTarget,
  type DeployTargetInput,
} from "../core/index.ts";
import {
  findPresetConflict,
  hasForeignNitroPlugin,
  markInjectedPlugins,
  pluginConflictMessage,
  presetConflictMessage,
  resolveNitroConfig,
  resolveNitroOutputDirs,
  type NitroConfigSlice,
} from "./UserConfig.ts";

/**
 * The structural slice of the project's `vite` module this package drives.
 * Typed structurally so the package carries no dependency on vite — the
 * *project's* install is always the one loaded.
 *
 * `createBuilder` (not `build`) is the entry point: SolidStart declares a
 * `builder.buildApp` that builds the client and SSR environments (and, with
 * the nitro plugin, runs nitro over the SSR bundle). Vite's legacy `build()`
 * only builds the default environment, so it would silently produce the
 * client bundle and nothing else.
 */
export interface SolidStartViteModule {
  readonly version?: string;
  readonly createBuilder: (
    config: Record<string, unknown>,
  ) => Promise<SolidStartViteBuilder>;
  readonly createServer: (
    config: Record<string, unknown>,
  ) => Promise<SolidStartViteDevServer>;
}

/** The structural slice of a vite builder this package reads. */
export interface SolidStartViteBuilder {
  readonly buildApp: () => Promise<unknown>;
}

/** The structural slice of a Vite dev server this package reads. */
export interface SolidStartViteDevServer {
  readonly listen: () => Promise<unknown>;
  readonly close: () => Promise<void>;
  readonly resolvedUrls?:
    | { readonly local: ReadonlyArray<string> }
    | null
    | undefined;
}

/**
 * The structural slice of the project's `@solidjs/vite-plugin-nitro-2`
 * module this package drives.
 */
export interface SolidStartNitroPluginModule {
  readonly nitroV2Plugin: (nitroConfig?: Record<string, unknown>) => unknown;
}

/** Inputs the framework passes when consulting the target's nitro hook. */
export interface SolidStartNitroContext {
  /** Absolute project root. */
  readonly root: string;
}

/**
 * The configuration this package assembles from {@link SolidStartOptions}
 * and hands to a deploy-target factory. The target treats it as its
 * `DeployTarget.config`; the framework half never inspects a resolved
 * target's config.
 */
export interface SolidStartTargetConfig {
  /**
   * Nitro options forwarded into the appended `nitroV2Plugin(...)` instance
   * (prerendering, route rules, storage, ...). `preset` is owned by the
   * deploy target and may not be set here.
   *
   * Carried on the target config so wholesale targets that re-run the
   * framework in a child process (the AWS target) can reconstruct the
   * framework with the same options.
   */
  readonly nitro?: Record<string, unknown> | undefined;
}

/**
 * A deploy target for SolidStart: the generic `DeployTarget` seams plus the
 * nitro hooks the SolidStart build needs — the deployment preset to build
 * with, and a last-word pass over the nitro config the integration hands to
 * the SolidStart nitro plugin.
 */
export interface SolidStartTarget extends DeployTarget<SolidStartTargetConfig> {
  /** The nitro deployment preset this target builds with (e.g. `"aws-lambda"`). */
  readonly nitroPreset: string;
  /**
   * Last-word mutation of the nitro config, run after the caller's `nitro`
   * overrides and after the preset is enforced (e.g. the AWS target forces
   * `awsLambda.streaming`).
   */
  readonly configureNitro?:
    | ((nitroConfig: NitroConfigSlice, context: SolidStartNitroContext) => void)
    | undefined;
}

/**
 * How a deploy target is passed to this package: a `SolidStartTarget` value,
 * a factory `(config) => SolidStartTarget`, or a module specifier resolved
 * from the *project's* `node_modules`.
 */
export type SolidStartTargetInput = DeployTargetInput<
  SolidStartTarget,
  SolidStartTargetConfig
>;

/**
 * The default deploy target: this package's own AWS Lambda target module,
 * loaded from the project's dependency tree. (Cloudflare deploys SolidStart
 * through its native Vite integration — `Cloudflare.Website.Vite` — so no
 * Cloudflare target exists here.)
 */
export const DEFAULT_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/solidstart/aws";

/** The specifier the project's SolidStart nitro plugin is loaded from. */
export const NITRO_PLUGIN_SPECIFIER = "@solidjs/vite-plugin-nitro-2";

export interface SolidStartOptions {
  /**
   * Project root (the directory containing `vite.config.*`).
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * The deploy target the build is produced for. Accepts a target value, a
   * `(config) => target` factory, or a module specifier string.
   * @default "@alchemy.run/frontend-frameworks/solidstart/aws"
   */
  readonly target?: SolidStartTargetInput | undefined;
  /**
   * Nitro options forwarded into the appended `nitroV2Plugin(...)` instance.
   * `preset` is owned by the deploy target and may not be set here.
   */
  readonly nitro?: Record<string, unknown> | undefined;
  readonly dev?:
    | {
        /** Default dev-server port (overridden by `FrameworkDevOptions.port`). */
        readonly port?: number | undefined;
      }
    | undefined;
}

const fail = (message: string, cause?: unknown) =>
  new FrameworkError({ framework: "solidstart", message, cause });

/**
 * Serializes cwd swaps across concurrent dev-server starts in one process (the
 * same discipline as the Waku framework's lock). Without it two interleaved
 * acquire/release pairs leave the process cwd pointing at the wrong project:
 * A chdir(/orig -> /a); B captures previous=/a, chdir(/b); A restores /orig;
 * B restores /a.
 */
const cwdLock = Semaphore.makeUnsafe(1);

/**
 * Run `effect` with the process working directory set to the project root,
 * restoring it afterwards. A no-op (and lock-free) when the cwd already is the
 * root — the case for the isolated build child process.
 *
 * SolidStart 2's `solidStart()` plugin resolves the app root, the route
 * directory, and the `~` alias from `process.cwd()` at config-load time —
 * not from vite's `root` — so it only finds the app when the process is IN
 * the project. Production builds are already isolated in a child process
 * whose cwd IS the root (see `aws.ts`), which makes this a no-op there; the
 * dev server runs in the caller's process (alchemy's dev sidecar), so the
 * cwd is aligned only across the window in which vite evaluates the config
 * module, and restored immediately after.
 *
 * Consequence, upstream and unavoidable while the plugin keys off the cwd:
 * one process can host the dev server of ONE SolidStart project at a time.
 */
const inProjectCwd = <A, E, R>(
  root: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | FrameworkError, R> =>
  Effect.flatMap(
    Effect.sync(() => process.cwd() === NodePath.resolve(root)),
    (isRoot) =>
      isRoot
        ? effect
        : Semaphore.withPermits(
            cwdLock,
            1,
          )(
            Effect.acquireUseRelease(
              Effect.try({
                try: () => {
                  const previous = process.cwd();
                  process.chdir(root);
                  return previous;
                },
                catch: (error) =>
                  fail(`Failed to enter the project directory ${root}`, error),
              }),
              () => effect,
              (previous) =>
                Effect.sync(() => {
                  try {
                    if (process.cwd() !== previous) {
                      process.chdir(previous);
                    }
                  } catch {
                    // restoring the cwd is best-effort
                  }
                }),
            ),
          ),
  );

/**
 * Build the `Framework` service implementation for a SolidStart project.
 *
 * - `build` resolves the deploy target, then either delegates wholesale
 *   (`target.build`) or drives the PROJECT's own Vite install
 *   programmatically: `createBuilder({ root, plugins: [nitroV2Plugin(...)] })`
 *   followed by `buildApp()`. The project's `vite.config.*` loads natively
 *   (its `solidStart()` plugin is untouched); the integration APPENDS a
 *   `nitroV2Plugin` instance — loaded from the project's own
 *   `node_modules` — carrying the deploy target's preset. Inline plugins are
 *   merged after the config file's, so the appended instance's
 *   `builder.buildApp` gets the last word. The `BuildOutput` is read from
 *   nitro's `.output`: `serverModules` entry-first from `.output/server`,
 *   `clientDirectory` = `.output/public` (prerendered pages included).
 * - `dev` runs the project's own Vite dev server (SolidStart's dev-server
 *   plugin serves SSR through it, with native HMR), scoped — closing the
 *   Scope closes the server. Nitro plays no part in dev.
 *
 * This module is target-agnostic: everything AWS-specific lives in
 * `@alchemy.run/frontend-frameworks/solidstart/aws`.
 */
export const make: (
  options?: SolidStartOptions,
) => Effect.Effect<
  Framework["Service"],
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (options?: SolidStartOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseRoot = options?.root ?? (yield* Effect.sync(() => process.cwd()));

  const targetConfig: SolidStartTargetConfig = { nitro: options?.nitro };

  const resolveTarget = (root: string) =>
    FrameworkCore.resolveDeployTarget<SolidStartTarget, SolidStartTargetConfig>(
      root,
      options?.target ?? DEFAULT_TARGET_SPECIFIER,
      targetConfig,
    ).pipe(Effect.mapError((error) => fail(error.message, error.cause)));

  const requireNitroPreset = (target: SolidStartTarget) =>
    typeof target.nitroPreset === "string" && target.nitroPreset.length > 0
      ? Effect.succeed(target)
      : Effect.fail(
          fail(
            `The resolved "${target.platform}" deploy target does not declare the nitro ` +
              "preset hook (`nitroPreset`) and has no wholesale `build`",
          ),
        );

  const loadVite = (root: string) =>
    FrameworkCore.loadProjectModule<SolidStartViteModule>(root, "vite").pipe(
      Effect.mapError((error) =>
        fail("Failed to load the project's Vite install", error.cause),
      ),
    );

  const loadNitroPlugin = (root: string) =>
    FrameworkCore.loadProjectModule<SolidStartNitroPluginModule>(
      root,
      NITRO_PLUGIN_SPECIFIER,
    ).pipe(
      Effect.mapError((error) =>
        fail(
          `Failed to load the project's "${NITRO_PLUGIN_SPECIFIER}" — install it alongside ` +
            "`@solidjs/start`; it is the server half of a SolidStart build",
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
        framework: "solidstart",
        env: buildOptions?.env,
      };

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

      yield* requireNitroPreset(target);

      // Conflict policy: the deploy target owns the preset, so a foreign one
      // is rejected with an actionable error instead of being replaced — a
      // build for a different preset would never be deployed.
      const conflict = findPresetConflict(options?.nitro, target.nitroPreset);
      if (conflict !== undefined) {
        return yield* Effect.fail(
          fail(presetConflictMessage(conflict, target.nitroPreset)),
        );
      }

      const vite = yield* loadVite(root);
      const nitro = yield* loadNitroPlugin(root);

      const nitroConfig = resolveNitroConfig({
        preset: target.nitroPreset,
        rootDir: root,
        nitro: options?.nitro,
        configure: (config) => target.configureNitro?.(config, { root }),
      });

      // Detected inside vite's own config resolution (the project's
      // `vite.config.*` has been loaded and merged by then), reported as a
      // FrameworkError once the build promise rejects.
      const detected = { conflict: false };
      const plugins = markInjectedPlugins([
        {
          name: "alchemy:solidstart-nitro-conflict",
          enforce: "pre" as const,
          config: (config: { readonly plugins?: unknown }) => {
            if (hasForeignNitroPlugin(config.plugins)) {
              detected.conflict = true;
              throw new Error(pluginConflictMessage());
            }
            return null;
          },
        },
        nitro.nitroV2Plugin(nitroConfig),
      ]);

      yield* inProjectCwd(
        root,
        Effect.tryPromise({
          try: async () => {
            const builder = await vite.createBuilder({
              root,
              // Fixture clones have no local node_modules, so Vite would
              // otherwise share `packages/alchemy/node_modules/.vite` with
              // every other website test. Vocs writes shiki there; the
              // SolidStart nitro graph then emits 11MB of grammars and
              // SSR GET `/` hangs. Pin the cache under this project.
              cacheDir: path.join(root, "node_modules", ".vite"),
              // Warn-level: rolldown-vite's native progress reporter writes
              // straight to the fd, corrupting hosting-process reporters
              // that can only intercept JS-level writers.
              logLevel: "warn",
              plugins,
            });
            return await builder.buildApp();
          },
          catch: (error) =>
            detected.conflict
              ? fail(pluginConflictMessage(), error)
              : fail("Failed to build", error),
        }),
      );

      const dirs = resolveNitroOutputDirs(nitroConfig, root, (...segments) =>
        path.resolve(...segments),
      );
      const output = yield* readNitroOutput(dirs).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      // The finishing-pass seam (none needed for the aws-lambda preset — the
      // output is already a self-contained Node deployment unit — but the
      // contract is honored for targets that do post-process).
      return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
        ...targetContext,
        entry: path.join(dirs.serverDir, "index.mjs"),
      }).pipe(
        Effect.mapError((error) => fail(error.message, error.cause)),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    },
  );

  const devInProcess: Framework["Service"]["dev"] = Effect.fn(
    function* (devOptions) {
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
        inProjectCwd(
          root,
          Effect.tryPromise({
            try: async () => {
              const server = await vite.createServer({
                root,
                cacheDir: path.join(root, "node_modules", ".vite"),
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
              fail("Failed to start the SolidStart dev server", error),
          }),
        ),
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
        return yield* Effect.fail(
          fail("Could not determine the dev server URL"),
        );
      }
      // Vite reports its local URL with a trailing slash. SolidStart runs with
      // `appType: "custom"`, so its router sees the raw pathname and a caller
      // that appends a path (`${url}/about`) would request `//about` and get a
      // 404. Hand back an origin that concatenates correctly.
      const url = resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;

      // Bounded readiness probe: any HTTP response counts (vite serves
      // lazily; we only need the listener to answer).
      yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(url, { redirect: "manual" });
          await response.arrayBuffer().catch(() => {});
        },
        catch: (error) =>
          fail("The dev server did not become reachable", error),
      }).pipe(
        Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
      );

      return { url };
    },
  );

  // SolidStart's `solidStart()` plugin resolves the app from `process.cwd()`
  // at config-load time, so its startup needs `cwd === root`. That must not
  // happen in a process hosting other sites (the alchemy dev sidecar) — run
  // the dev server in a dedicated child whose cwd IS the root instead (see
  // core/DevChild.ts). Inside that child (or when the options cannot cross
  // the process boundary, e.g. a deploy-target VALUE from the e2e harness)
  // the in-process path runs directly.
  const dev: Framework["Service"]["dev"] = (devOptions) => {
    const root = devOptions?.root ?? baseRoot;
    const port = devOptions?.port ?? options?.dev?.port;
    if (
      FrameworkCore.isInsideDevChild() ||
      !FrameworkCore.isJsonSerializable(options)
    ) {
      return devInProcess(devOptions);
    }
    return FrameworkCore.runDevChild({
      framework: "solidstart",
      module: "@alchemy.run/frontend-frameworks/solidstart",
      callerUrl: import.meta.url,
      rootDir: root,
      makeOptions: { ...options, root },
      devOptions: {
        root,
        ...(port !== undefined ? { port } : {}),
        ...(devOptions?.host !== undefined ? { host: devOptions.host } : {}),
      },
    });
  };

  return Framework.of({ build, dev });
});

/** The nitro server entry's module name within the `BuildOutput` (POSIX). */
export const SERVER_ENTRY_NAME = "server/index.mjs";

/** The resolved nitro output directories. */
export interface NitroOutputDirs {
  /** Root output directory (`.output`). */
  readonly dir: string;
  /** Server bundle directory (`.output/server`). */
  readonly serverDir: string;
  /** Static assets directory (`.output/public`, prerendered pages included). */
  readonly publicDir: string;
}

/**
 * Map nitro's on-disk `.output` onto the `BuildOutput` contract:
 * `serverModules` entry-first from the server directory (POSIX names,
 * sha256-hashed), `clientDirectory` = the public directory. Nitro's output
 * is self-contained (externals are copied into `.output/server/node_modules`),
 * so there are no external workspace roots to watch.
 */
export const readNitroOutput = (
  dirs: NitroOutputDirs,
): Effect.Effect<
  FrameworkCore.BuildOutput,
  FrameworkError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const modules = yield* FrameworkCore.readServerModulesFromDisk({
      directory: dirs.serverDir,
      prefix: "server",
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause)));
    if (modules.length === 0) {
      return yield* Effect.fail(
        fail(
          `The SolidStart build produced no server modules in ${dirs.serverDir}`,
        ),
      );
    }
    const serverModules = FrameworkCore.sortServerModules(
      modules,
      SERVER_ENTRY_NAME,
    );
    if (serverModules[0]?.name !== SERVER_ENTRY_NAME) {
      return yield* Effect.fail(
        fail(
          `The SolidStart build produced no "${SERVER_ENTRY_NAME}" entry in ${dirs.serverDir}`,
        ),
      );
    }
    return {
      distDirectory: dirs.dir,
      clientDirectory: dirs.publicDir,
      serverModules,
      externalWorkspaces: new Set<string>(),
    } satisfies FrameworkCore.BuildOutput;
  });

/**
 * A `Layer` providing framework-core's `Framework` service for a SolidStart
 * project — the fully-typed entrypoint for `e2e.config.ts` and alchemy's
 * `AWS.Website.SolidStart` composite.
 */
export const layer = (
  options?: SolidStartOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Framework, make(options));
