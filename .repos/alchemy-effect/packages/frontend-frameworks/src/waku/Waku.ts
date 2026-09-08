import * as FrameworkCore from "../core/index.ts";
import type {
  BuildOutput,
  DeployTarget,
  DeployTargetBuildContext,
  DeployTargetError,
  DeployTargetInput,
  DeployTargetServices,
} from "../core/index.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as NodePath from "node:path";
import type * as ViteModule from "vite";
import type { Config as WakuConfig } from "waku/config";
import type * as WakuInternals from "waku/internals";
import type * as WakuVitePlugins from "waku/vite-plugins";

type WakuInternalsModule = typeof WakuInternals;
type WakuVitePluginsModule = typeof WakuVitePlugins;
type ResolvedWakuConfig = ReturnType<
  WakuInternalsModule["unstable_resolveConfig"]
>;

/**
 * Waku's rsc-environment worker entry, relative to the installed `waku`
 * package directory. Its default export is the adapter's `ExportedHandler`
 * (the same module waku wires as the rsc env's `index` input). The deep path
 * is not in waku's exports map, so it is joined onto the resolved package
 * directory.
 *
 * Deploy targets whose bundler plugin needs an explicit entry (e.g. the
 * cloudflare target's `main`) pin it to this path: waku's rsc environment
 * declares two rolldown inputs (`index` + `build`) while such plugins assert
 * exactly one entry.
 */
export const WAKU_SERVER_ENTRY_PATH = "dist/lib/vite-entries/entry.server.js";

/**
 * The server module that must become `serverModules[0]` when the app has no
 * user worker entry: waku's own `index` input of the rsc environment
 * (`dist/server/index.js`), whose default export is the adapter's
 * `ExportedHandler`. The entry environment emits multiple entry chunks
 * (`index`, `build`, and any wrapped worker entry), so entry selection is
 * pinned to this name. When the deploy target carries a user entry
 * (`target.entry`), the chunk built from the user's `main` is pinned instead
 * (framework-core's `selectEntryByFacade`) and this module remains an
 * ordinary chunk the user entry imports.
 */
export const WAKU_SERVER_ENTRY_MODULE = NodePath.join("server", "index.js");

/**
 * The stable importable specifier for waku's server handler — the module a
 * USER worker entry wraps (the deploy-target user-entry seam; precedent:
 * React Router's `virtual:react-router/server-build`). Resolves to waku's
 * rsc server entry ({@link WAKU_SERVER_ENTRY_PATH}), whose default export is
 * the adapter's `ExportedHandler`, in dev and build alike:
 *
 * ```ts
 * // src/worker-entry.ts
 * import wakuHandler from "virtual:waku/server-entry";
 * export class Counter extends DurableObject {}
 * export default {
 *   fetch: (request, env, ctx) => wakuHandler.fetch(request, env, ctx),
 * };
 * ```
 */
export const WAKU_SERVER_ENTRY_ID = "virtual:waku/server-entry";

/**
 * The vite plugin resolving {@link WAKU_SERVER_ENTRY_ID} to the project's
 * installed waku server entry. Platform-neutral (the id maps to the same
 * framework module for every deploy target) and always injected first in
 * `vite.plugins`, so the id resolves for the dev module runner, the
 * production build, and the SSG preview server alike.
 */
export const makeWakuServerEntryPlugin = (
  wakuDirectory: string,
): ViteModule.Plugin => ({
  name: "distilled-waku:server-entry",
  resolveId(id) {
    if (id === WAKU_SERVER_ENTRY_ID) {
      return NodePath.join(wakuDirectory, WAKU_SERVER_ENTRY_PATH);
    }
    return undefined;
  },
});

/**
 * The inputs a {@link WakuTarget} hook receives: enough to synthesize the
 * target's bundler plugins and adapter selection for one waku pass.
 */
export interface WakuTargetContext {
  /** Absolute project root. */
  readonly root: string;
  /** Directory of the project's installed `waku` package. */
  readonly wakuDirectory: string;
  /** Which waku pass the hook feeds: the production build or the HMR dev server. */
  readonly phase: "build" | "dev";
}

/**
 * The waku-specific deploy-target contract: the generic
 * `framework-core` {@link DeployTarget} seams plus the two
 * hooks a target must implement to slot into waku's toolchain:
 *
 * - `adapter` — the absolute path of the waku server-entry adapter module the
 *   in-memory config selects via `unstable_adapter`. Always required: leaving
 *   `unstable_adapter` unset makes waku silently pick `waku/adapters/node`,
 *   which cannot run on a non-Node target runtime.
 * - `vitePlugins` — vite plugins injected *first* inside waku's
 *   `config.vite.plugins` (waku's `extraPlugins` places user plugins first,
 *   ahead of waku's own environments plugin) — the position upstream
 *   documents for `@cloudflare/vite-plugin`, and the only one where a
 *   target's request-proxy middleware registers before waku's Node request
 *   bridge.
 *
 * The Cloudflare implementation ships at `@alchemy.run/frontend-frameworks/waku/cloudflare`
 * (the default). A future target (e.g. AWS) is a new module implementing the
 * same two hooks — no change to this package's orchestration.
 */
export interface WakuTarget<Config = unknown> extends DeployTarget<Config> {
  /** Absolute path of the adapter module waku's config selects via `unstable_adapter`. */
  readonly adapter: (
    context: WakuTargetContext,
  ) => Effect.Effect<string, DeployTargetError>;
  /** Vite plugins injected first inside waku's `vite.plugins` (dev + build). */
  readonly vitePlugins: (
    context: WakuTargetContext,
  ) => Effect.Effect<ReadonlyArray<ViteModule.PluginOption>, DeployTargetError>;
  /**
   * Optional *wholesale* build takeover (see `DeployTarget.build`), with
   * the waku-specific {@link WakuTargetBuildContext}.
   */
  readonly build?:
    | ((
        context: WakuTargetBuildContext,
      ) => Effect.Effect<BuildOutput, DeployTargetError, DeployTargetServices>)
    | undefined;
}

/**
 * The context a waku target's wholesale `build` takeover receives: the
 * generic build context plus the inline waku options the framework was
 * constructed with ({@link WakuFrameworkOptions.waku}) — carried so
 * wholesale targets that re-run the framework in a child process (the AWS
 * target) can reconstruct it. Only JSON-serializable fields survive that
 * process boundary.
 */
export interface WakuTargetBuildContext extends DeployTargetBuildContext {
  readonly waku?: WakuConfig | undefined;
}

/**
 * Structural mirror of the e2e harness's target-scoped config carriage
 * (`Options.TargetOptions`): a plain selection object whose `cloudflare.worker`
 * carries the cloudflare target's configuration. Distinguished from a
 * {@link DeployTargetInput} structurally (it is neither a
 * string, a function, nor a `DeployTarget` value).
 */
export interface WakuHarnessTargetOptions {
  /** Which platform target drives the integration. @default "cloudflare" */
  readonly name?: string | undefined;
  readonly cloudflare?: { readonly worker?: unknown } | undefined;
}

/**
 * How the deploy target is passed to the waku integration:
 *
 * - a target value / factory / module-specifier string (a
 *   {@link DeployTargetInput}) — resolved with
 *   `resolveDeployTarget`
 * - the e2e harness's target-scoped carriage
 *   ({@link WakuHarnessTargetOptions}) — selects the default cloudflare
 *   target module and hands it `cloudflare.worker` as its config
 * - omitted — the default cloudflare target module with the deprecated
 *   `vite` alias as its config
 */
export type WakuTargetOption =
  | DeployTargetInput<WakuTarget, unknown>
  | WakuHarnessTargetOptions;

/**
 * The module specifier of the default deploy target, loaded from the
 * *project's* `node_modules` when no explicit target is passed.
 */
export const DEFAULT_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/waku/cloudflare";

/**
 * Options for the Waku `Framework` integration.
 */
export interface WakuFrameworkOptions {
  /**
   * The deploy target the build is produced for. Accepts a target value
   * (build it by importing the target module, e.g.
   * `@alchemy.run/frontend-frameworks/waku/cloudflare`, for full config type safety), a
   * `(config) => target` factory, a module specifier string, or the e2e
   * harness's target-scoped carriage. Defaults to the cloudflare target
   * module ({@link DEFAULT_TARGET_SPECIFIER}).
   */
  readonly target?: WakuTargetOption | undefined;
  /**
   * @deprecated Alias for the deploy target's configuration (the harness's
   * pre-target `vite` field, carrying the cloudflare worker configuration).
   * Prefer passing a fully-built target via {@link target}, or the harness's
   * target-scoped `target.cloudflare.worker`.
   */
  readonly vite?: unknown;
  /**
   * Extra waku config (`srcDir`, `distDir`, `vite`, ...) merged OVER the
   * project's own `waku.config.ts`/`waku.config.js`, which is always loaded
   * natively first (same semantics as waku's CLI — see
   * {@link mergeUserWakuConfig}). `unstable_adapter` is owned by the deploy
   * target and must not be set here or in the config file.
   */
  readonly waku?: WakuConfig | undefined;
  /** Project root. Defaults to the process working directory. */
  readonly root?: string | undefined;
  /**
   * Default dev-server port, used when `dev` is called without an explicit
   * port (e.g. the e2e harness's Playwright dev fixture). Non-strict: if the
   * port is taken, vite falls back to the next free one. A port passed to
   * `dev` directly (`e2e dev --port N`) is strict and takes precedence.
   */
  readonly port?: number | undefined;
}

/**
 * The config files waku's CLI probes for, in probe order (see waku's
 * `lib/vite-rsc/loader.ts` `loadConfig`). Only the existence probe uses these
 * names — the actual import goes through vite's resolver as `/waku.config`,
 * exactly like upstream.
 */
export const WAKU_CONFIG_FILES = ["waku.config.ts", "waku.config.js"] as const;

/** Strip `undefined`-valued keys so an inline options object with explicit
 * `undefined` entries cannot clobber values from the user's config file. */
const definedConfig = (
  config: WakuConfig | undefined,
): WakuConfig | undefined => {
  if (config === undefined) {
    return undefined;
  }
  const entries = Object.entries(config).filter(
    ([, value]) => value !== undefined,
  );
  return entries.length === 0
    ? undefined
    : (Object.fromEntries(entries) as WakuConfig);
};

/** Inputs for {@link mergeUserWakuConfig} (exported for testing). */
export interface MergeUserWakuConfigInputs {
  /** The natively loaded `waku.config.ts`/`waku.config.js` default export. */
  readonly file: WakuConfig | undefined;
  /** The integration's inline waku options ({@link WakuFrameworkOptions.waku}). */
  readonly inline: WakuConfig | undefined;
  /** vite's `mergeConfig` (from the project's vite installation). */
  readonly mergeViteConfig: (
    defaults: ViteModule.UserConfig,
    overrides: ViteModule.UserConfig,
  ) => ViteModule.UserConfig;
}

/**
 * Merge the project's natively loaded waku config file with the integration's
 * inline waku options: the file is the base, inline options win per key
 * (mirroring vite's file-config-vs-inline-config precedence), and the `vite`
 * fields are combined with vite's own `mergeConfig` (arrays like `plugins`
 * concatenate — file plugins first, inline plugins after).
 */
export const mergeUserWakuConfig = (
  inputs: MergeUserWakuConfigInputs,
): WakuConfig | undefined => {
  const file = definedConfig(inputs.file);
  const inline = definedConfig(inputs.inline);
  if (file === undefined || inline === undefined) {
    return file ?? inline;
  }
  const vite =
    file.vite !== undefined && inline.vite !== undefined
      ? inputs.mergeViteConfig(file.vite, inline.vite)
      : (inline.vite ?? file.vite);
  return { ...file, ...inline, ...(vite !== undefined ? { vite } : undefined) };
};

const isDeployTargetInput = (
  value: unknown,
): value is DeployTargetInput<WakuTarget, unknown> =>
  typeof value === "string" ||
  typeof value === "function" ||
  FrameworkCore.isDeployTarget(value);

/** The normalized `(input, config)` pair fed to `resolveDeployTarget`. */
export interface WakuTargetInputSelection {
  readonly input: DeployTargetInput<WakuTarget, unknown>;
  readonly config: unknown;
}

/**
 * Normalize {@link WakuFrameworkOptions} into the `(input, config)` pair for
 * `resolveDeployTarget`:
 *
 * - an explicit `DeployTargetInput` is used as-is, with the deprecated `vite`
 *   alias as the config a factory/specifier receives
 * - the harness carriage (or no target at all) selects the default target
 *   module with `target.cloudflare.worker ?? vite` as its config
 */
export const selectWakuTargetInput = (
  options?: WakuFrameworkOptions,
): WakuTargetInputSelection => {
  const raw = options?.target;
  if (raw !== undefined && isDeployTargetInput(raw)) {
    return { input: raw, config: options?.vite };
  }
  return {
    input: DEFAULT_TARGET_SPECIFIER,
    config: raw?.cloudflare?.worker ?? options?.vite,
  };
};

/** Inputs for {@link makeWakuConfigInput} (exported for testing). */
export interface WakuConfigInputs {
  /** Absolute path of the adapter module (the target's `adapter` hook). */
  readonly adapterPath: string;
  /**
   * Deploy-target vite plugins injected first inside `vite.plugins` (the
   * target's `vitePlugins` hook). The SSG preview server resolves the same
   * config — upstream parity: waku's CLI reuses the loaded config's plugin
   * instances for both `createBuilder` and `vite.preview` — so a target
   * whose plugins implement `configurePreviewServer` (the cloudflare
   * target's does) serves SSG through its own runtime.
   */
  readonly plugins?: ReadonlyArray<ViteModule.PluginOption> | undefined;
  /**
   * The user's waku config — the natively loaded `waku.config.ts`/`.js`
   * merged with the integration's inline waku options (see
   * {@link mergeUserWakuConfig}). Its `vite` config is preserved; a user
   * `unstable_adapter` is rejected by the caller before this point (the
   * deploy target owns the adapter), so this function pins it
   * unconditionally.
   */
  readonly userConfig?: WakuConfig | undefined;
}

const mergeWorkerEnvironment = (
  user: ViteModule.EnvironmentOptions | undefined,
  optimizeDepsInclude: Array<string>,
): ViteModule.EnvironmentOptions => ({
  ...user,
  optimizeDeps: {
    ...user?.optimizeDeps,
    include: [...optimizeDepsInclude, ...(user?.optimizeDeps?.include ?? [])],
  },
  build: {
    ...user?.build,
    rolldownOptions: {
      platform: "neutral",
      ...user?.build?.rolldownOptions,
    },
  },
});

/**
 * Build the waku `Config` fed to waku's `unstable_resolveConfig`: the USER's
 * config (their natively loaded `waku.config.*`, plus any inline waku
 * options) with the deploy target's required fields merged over it:
 *
 * - `unstable_adapter` is pinned to the deploy target's adapter module.
 *   Leaving it unset would silently select `waku/adapters/node` (no
 *   `CLOUDFLARE` env var), which cannot run on a non-Node target runtime;
 *   a user-set adapter is rejected upstream of this function.
 * - The target's vite plugins are injected INSIDE `vite.plugins` (waku's
 *   `extraPlugins` places user plugins first, ahead of waku's own
 *   environments plugin) — the position upstream documents for
 *   `@cloudflare/vite-plugin`, and the only one where the target's proxy
 *   middleware registers before waku's Node request bridge.
 * - `waku` and `hono` are deduped so the adapter module (which lives outside
 *   the project) resolves the project's copies.
 * - rsc/ssr get the documented `optimizeDeps.include` entries and
 *   `platform: "neutral"`.
 */
export const makeWakuConfigInput = (inputs: WakuConfigInputs): WakuConfig => {
  const user = inputs.userConfig;
  const userVite = user?.vite;
  const environments = (userVite?.environments ?? {}) as Record<
    string,
    ViteModule.EnvironmentOptions | undefined
  >;
  return {
    ...user,
    unstable_adapter: inputs.adapterPath,
    vite: {
      ...userVite,
      resolve: {
        ...userVite?.resolve,
        dedupe: [
          ...new Set(["waku", "hono", ...(userVite?.resolve?.dedupe ?? [])]),
        ],
      },
      environments: {
        ...userVite?.environments,
        rsc: mergeWorkerEnvironment(environments.rsc, ["hono/tiny"]),
        ssr: mergeWorkerEnvironment(environments.ssr, [
          "waku > rsc-html-stream/server",
        ]),
      },
      plugins: [...(inputs.plugins ?? []), ...(userVite?.plugins ?? [])],
    },
  };
};

/**
 * `NODE_ENV` as it was when this module first loaded. Waku's CLI sets
 * `NODE_ENV` before loading anything (waku's environmentsPlugin bakes
 * `process.env.NODE_ENV` into `define`), which we replicate — but a
 * long-lived process may run both `build` and `dev` (e.g. a playwright worker
 * driving the live and dev servers), and a plain `??=` would leak the first
 * operation's value into the second. Capturing the initial value preserves an
 * explicit user override while keeping the two operations independent.
 */
const INITIAL_NODE_ENV = process.env.NODE_ENV;

/**
 * Serializes cwd swaps across concurrent builds in one process (the same
 * discipline as the source provider's dev-server startup lock).
 */
const cwdLock = Semaphore.makeUnsafe(1);

/**
 * Run `effect` with `process.cwd()` set to the project root, restoring the
 * previous cwd afterwards. Waku's toolchain assumes cwd == root: the
 * html-shell plugin declares a cwd-relative `index.html` client input (a
 * root outside the cwd makes `vite:build-html` emit an invalid
 * `../index.html` asset name) and reads the html shell with bare relative
 * paths. A no-op when the cwd already is the root.
 */
const withRootCwd = <A, E, R>(
  root: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
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
              Effect.sync(() => {
                const previous = process.cwd();
                process.chdir(root);
                return previous;
              }),
              () => effect,
              (previous) => Effect.sync(() => process.chdir(previous)),
            ),
          ),
  );

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
 * Replicates waku's `cmd-build.ts` `startPreviewServerImpl`: the SSG step of
 * `builder.buildApp()` (the adapter's `build`) calls
 * `unstable_startPreviewServer`, which throws unless this global is set. The
 * preview server resolves the SAME waku config as the build — upstream
 * parity: waku's CLI calls `combinedPlugins(config)` for both
 * `createBuilder` and `vite.preview`, reusing the loaded config's plugin
 * instances across the two servers. A deploy target whose vite plugins
 * implement `configurePreviewServer` (the cloudflare target serves the
 * freshly built worker through workerd) therefore hosts the SSG rendering on
 * its own runtime; waku's adapter registers its Node fallback middleware
 * behind it, which only fires for targets without a preview mode.
 */
const setPreviewServerGlobal = (
  vite: typeof ViteModule,
  vitePlugins: WakuVitePluginsModule,
  root: string,
  previewConfig: ResolvedWakuConfig,
): void => {
  (globalThis as Record<string, unknown>)[PREVIEW_SERVER_GLOBAL] =
    async (): Promise<WakuPreviewServer> => {
      const server = await vite.preview({
        configFile: false,
        root,
        plugins: [vitePlugins.unstable_combinedPlugins(previewConfig)],
      });
      const baseUrl = server.resolvedUrls?.local[0];
      if (!baseUrl) {
        throw new Error(
          "Could not determine the URL of the waku SSG preview server",
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

interface ProjectModules {
  readonly vite: typeof ViteModule;
  readonly internals: WakuInternalsModule;
  readonly vitePlugins: WakuVitePluginsModule;
  readonly wakuDirectory: string;
}

/**
 * The Waku implementation of framework-core's `Framework` service.
 *
 * - `build` replicates waku's `runBuild` (`vite.createBuilder` +
 *   `combinedPlugins` + the SSG preview-server global) and collects the
 *   `BuildOutput` with a post-`buildApp` disk re-read (waku writes
 *   `__waku_build_metadata.js` and prunes static-only chunks after the
 *   bundler finishes). The result is returned in-memory only, then passed
 *   through the deploy target's finishing pass (if any).
 * - `dev` replicates waku's `runDev` with the deploy target's vite plugins
 *   injected inside waku's `config.vite.plugins`, so the rsc environment runs
 *   on the target's dev runtime (workerd for cloudflare) with in-memory
 *   bindings.
 *
 * Deploy-target resolution happens per operation: platform-specific halves
 * (adapter module, bundler plugins) come exclusively from the resolved
 * {@link WakuTarget} — this module contains no platform imports.
 *
 * Returns the service implementation as an Effect (the alchemy-side
 * `FrameworkModule` contract); use {@link layer} for the `Layer` form the
 * e2e harness consumes.
 */
export const make = (
  options?: WakuFrameworkOptions,
): Effect.Effect<
  FrameworkCore.Framework["Service"],
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const fail = (message: string) => (cause: unknown) =>
      new FrameworkCore.FrameworkError({ framework: "waku", message, cause });

    const resolveRoot = (override: string | undefined) =>
      Effect.sync(() => override ?? options?.root ?? process.cwd());

    const resolveTarget: (
      root: string,
    ) => Effect.Effect<WakuTarget, FrameworkCore.FrameworkError> = Effect.fn(
      function* (root: string) {
        const { input, config } = selectWakuTargetInput(options);
        return yield* FrameworkCore.resolveDeployTarget<WakuTarget, unknown>(
          root,
          input,
          config,
        ).pipe(Effect.mapError(fail("Failed to resolve the deploy target")));
      },
    );

    /** Run the target's waku hooks, validating they exist (a dynamically
     * loaded module may satisfy `DeployTarget` without the waku hooks). */
    const useTargetHooks: (
      target: WakuTarget,
      context: WakuTargetContext,
    ) => Effect.Effect<
      {
        adapterPath: string;
        plugins: ReadonlyArray<ViteModule.PluginOption>;
      },
      FrameworkCore.FrameworkError
    > = Effect.fn(function* (target: WakuTarget, context: WakuTargetContext) {
      if (
        typeof target.adapter !== "function" ||
        typeof target.vitePlugins !== "function"
      ) {
        return yield* Effect.fail(
          fail(
            `Deploy target "${target.platform}" does not implement the waku target hooks ` +
              "(adapter, vitePlugins) required to drive waku " +
              context.phase,
          )(undefined),
        );
      }
      const [adapterPath, plugins] = yield* Effect.all(
        [target.adapter(context), target.vitePlugins(context)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          fail(`The deploy target failed preparing the waku ${context.phase}`),
        ),
      );
      return { adapterPath, plugins };
    });

    const loadProject: (
      root: string,
    ) => Effect.Effect<ProjectModules, FrameworkCore.FrameworkError> =
      Effect.fn(function* (root: string) {
        const [vite, internals, vitePlugins, wakuDirectory] = yield* Effect.all(
          [
            FrameworkCore.loadProjectModule<typeof ViteModule>(
              root,
              "vite",
            ).pipe(Effect.mapError(fail("Failed to load the project's vite"))),
            FrameworkCore.loadProjectModule<WakuInternalsModule>(
              root,
              "waku/internals",
            ).pipe(
              Effect.mapError(
                fail("Failed to load the project's waku/internals"),
              ),
            ),
            FrameworkCore.loadProjectModule<WakuVitePluginsModule>(
              root,
              "waku/vite-plugins",
            ).pipe(
              Effect.mapError(
                fail("Failed to load the project's waku/vite-plugins"),
              ),
            ),
            FrameworkCore.resolveProjectPackageDirectory(root, "waku").pipe(
              Effect.mapError(
                fail("Failed to resolve the project's waku package directory"),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );
        return { vite, internals, vitePlugins, wakuDirectory };
      });

    /**
     * Load the project's `waku.config.ts`/`waku.config.js` exactly the way
     * waku's own CLI does. Waku's loader (`lib/vite-rsc/loader.ts`
     * `loadConfig`) is NOT exported, so its semantics are replicated: an
     * existence probe for {@link WAKU_CONFIG_FILES} at the project root
     * (waku probes the cwd — its CLI always runs from the project),
     * followed by `vite.runnerImport("/waku.config")` with the project's
     * own vite. `runnerImport`'s inline config pins `root` so the
     * root-relative id resolves identically when root !== cwd. `NODE_ENV`
     * is set before this runs, matching waku's CLI ordering (vite#20299).
     *
     * Deliberate divergences from the CLI (host-process concerns):
     * - no `loadDotEnv()` — the CLI mutates `process.env` from
     *   `.env.local`/`.env`; here the host (alchemy/e2e) owns the process
     *   environment and worker env comes from bindings.
     * - no dev-server restart on config-file change — the dev handle is a
     *   plain URL; edits to `waku.config.*` need a dev restart.
     */
    const loadUserConfigFile: (
      project: ProjectModules,
      root: string,
    ) => Effect.Effect<WakuConfig | undefined, FrameworkCore.FrameworkError> =
      Effect.fn(function* (project: ProjectModules, root: string) {
        const exists = yield* Effect.all(
          WAKU_CONFIG_FILES.map((file) => fs.exists(path.join(root, file))),
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            fail("Failed to probe for the project's waku.config file"),
          ),
        );
        if (!exists.some(Boolean)) {
          return undefined;
        }
        return yield* Effect.tryPromise({
          try: async () => {
            const imported = await project.vite.runnerImport<{
              default: WakuConfig;
            }>("/waku.config", { root });
            return imported.module.default;
          },
          catch: fail("Failed to load the project's waku.config file"),
        });
      });

    const makeConfig: (
      project: ProjectModules,
      root: string,
      inputs: {
        adapterPath: string;
        plugins: ReadonlyArray<ViteModule.PluginOption>;
      },
    ) => Effect.Effect<ResolvedWakuConfig, FrameworkCore.FrameworkError> =
      Effect.fn(function* (
        project: ProjectModules,
        root: string,
        inputs: {
          adapterPath: string;
          plugins: ReadonlyArray<ViteModule.PluginOption>;
        },
      ) {
        const fileConfig = yield* loadUserConfigFile(project, root);
        const userConfig = mergeUserWakuConfig({
          file: fileConfig,
          inline: options?.waku,
          mergeViteConfig: project.vite.mergeConfig,
        });
        if (userConfig?.unstable_adapter !== undefined) {
          return yield* Effect.fail(
            fail(
              `The waku config sets unstable_adapter (${JSON.stringify(userConfig.unstable_adapter)}), ` +
                "but the deploy target owns the server adapter " +
                `(it injects ${JSON.stringify(inputs.adapterPath)}). ` +
                "Remove unstable_adapter from waku.config.ts/waku.config.js (and from the " +
                "integration's waku options); to change the deploy platform, pass a different " +
                "deploy target to the integration instead.",
            )(undefined),
          );
        }
        return project.internals.unstable_resolveConfig(
          makeWakuConfigInput({
            adapterPath: inputs.adapterPath,
            // The server-entry resolver goes first so
            // `virtual:waku/server-entry` (the wrappable-handler seam a user
            // worker entry imports) resolves in dev, build, and the SSG
            // preview server alike.
            plugins: [
              makeWakuServerEntryPlugin(project.wakuDirectory),
              ...inputs.plugins,
            ],
            userConfig,
          }),
        );
      });

    const inProcess = FrameworkCore.Framework.of({
      build: Effect.fn(function* (buildOptions) {
        const root = yield* resolveRoot(buildOptions?.root);
        const target = yield* resolveTarget(root);
        if (target.build !== undefined) {
          // Wholesale build takeover: the target owns the entire pipeline.
          // The inline waku options ride along so a child-process build can
          // reconstruct the framework with the same options.
          return yield* target
            .build({
              root,
              framework: "waku",
              env: buildOptions?.env,
              waku: options?.waku,
            })
            .pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.mapError(fail("The deploy target's build failed")),
            );
        }
        const project = yield* loadProject(root);
        const hooks = yield* useTargetHooks(target, {
          root,
          wakuDirectory: project.wakuDirectory,
          phase: "build",
        });
        // waku's CLI sets this before loading anything; waku's
        // environmentsPlugin bakes `process.env.NODE_ENV` into `define`.
        yield* Effect.sync(() => {
          process.env.NODE_ENV = INITIAL_NODE_ENV ?? "production";
        });
        const wakuConfig = yield* makeConfig(project, root, hooks);
        // Entry selection (the user-entry seam): when the deploy target
        // carries a user worker entry, the chunk built from it must become
        // `serverModules[0]` — waku's own `server/index.js` remains an
        // ordinary chunk the user entry imports (via
        // `virtual:waku/server-entry`). Without one, waku's own `index`
        // entry chunk is pinned by name as before.
        const userEntry = FrameworkCore.resolveDeployTargetEntry(target, {
          root,
        });
        const collector = yield* FrameworkCore.makeBuildOutputCollector({
          entryEnvironment: "rsc",
          selectEntry:
            userEntry !== undefined
              ? FrameworkCore.selectEntryByFacade(userEntry)
              : (chunk) => chunk.name === WAKU_SERVER_ENTRY_MODULE,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        // The whole build runs under the project root cwd: waku's
        // html-shell plugin declares a cwd-relative `index.html` client
        // input and reads the shell with bare relative paths (see
        // withRootCwd).
        yield* withRootCwd(
          root,
          Effect.tryPromise({
            try: async () => {
              const builder = await project.vite.createBuilder(
                {
                  configFile: false,
                  root,
                  // Warn-level: rolldown-vite's native progress reporter
                  // ("transforming...") writes straight to the fd, which
                  // corrupts hosting-process reporters (e.g. alchemy-test)
                  // that can only intercept JS-level writers.
                  logLevel: "warn",
                  plugins: [
                    project.vitePlugins.unstable_combinedPlugins(wakuConfig),
                    collector.plugin,
                  ],
                },
                null,
              );
              setPreviewServerGlobal(
                project.vite,
                project.vitePlugins,
                root,
                wakuConfig,
              );
              try {
                await builder.buildApp();
              } finally {
                clearPreviewServerGlobal();
              }
            },
            catch: fail("Failed to build"),
          }),
        );
        // Disk re-read: waku writes `__waku_build_metadata.js` and prunes
        // static-only server chunks during `buildApp` hooks, after the
        // in-memory `writeBundle` capture.
        const output = yield* collector
          .collect({ fromDisk: true })
          .pipe(Effect.mapError((error) => fail(error.message)(error.cause)));
        return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
          root,
          framework: "waku",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(fail("The deploy target's finishing pass failed")),
        );
      }),
      dev: Effect.fn(function* (devOptions) {
        const root = yield* resolveRoot(devOptions?.root);
        const target = yield* resolveTarget(root);
        const project = yield* loadProject(root);
        const hooks = yield* useTargetHooks(target, {
          root,
          wakuDirectory: project.wakuDirectory,
          phase: "dev",
        });
        yield* Effect.sync(() => {
          process.env.NODE_ENV = INITIAL_NODE_ENV ?? "development";
        });
        const wakuConfig = yield* makeConfig(project, root, hooks);
        // `port: 0` (true OS-assigned) on Vite >= 8.2.1, probed ephemeral
        // port on older Vite — see `resolveViteDevPort`. strictPort stays
        // off for allocated ports so a probe race just moves to the next
        // ephemeral port.
        const explicitPort = devOptions?.port || options?.port;
        const port = yield* FrameworkCore.resolveViteDevPort(
          project.vite.version,
          explicitPort,
        );
        const host = devOptions?.host;
        // The dev server *starts* under the project root cwd (waku
        // resolves its html shell and relative inputs from the cwd at
        // startup); the cwd is restored once the server is listening.
        const server = yield* Effect.acquireRelease(
          withRootCwd(
            root,
            Effect.tryPromise({
              try: async () => {
                const server = await project.vite.createServer({
                  configFile: false,
                  root,
                  plugins: [
                    project.vitePlugins.unstable_combinedPlugins(wakuConfig),
                  ],
                  server: {
                    port,
                    strictPort: !!explicitPort,
                    ...(host !== undefined ? { host } : undefined),
                  },
                });
                return await server.listen();
              },
              catch: fail("Failed to start the waku dev server"),
            }),
          ),
          (server) => Effect.promise(async () => await server.close()),
        );
        const resolved = server.resolvedUrls?.local[0];
        if (resolved === undefined) {
          return yield* Effect.fail(
            fail("Could not determine the URL of the waku dev server")(
              undefined,
            ),
          );
        }
        // Vite's `resolvedUrls.local[0]` is `http://host:port/` — strip
        // the trailing slash so callers can concatenate paths (`${url}/`)
        // without producing `//`, which waku's router does not match.
        const url = resolved.replace(/\/+$/, "");
        // Bounded readiness probe: any HTTP response counts (waku's
        // first RSC compile is lazy; we only need the listener to answer).
        yield* Effect.tryPromise({
          try: async () => {
            const response = await fetch(`${url}/`, { redirect: "manual" });
            await response.arrayBuffer().catch(() => {});
          },
          catch: fail("The waku dev server did not become reachable"),
        }).pipe(
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
        );
        return { url };
      }),
    });

    // Waku's toolchain assumes `cwd === root` at dev startup (the html shell
    // and relative inputs resolve from the cwd), so its startup window
    // chdirs — which must not happen in a process hosting other sites' dev
    // servers (the alchemy dev sidecar). Run the dev server in a dedicated
    // child whose cwd IS the root instead (see core/DevChild.ts). Inside
    // that child — or when the options cannot cross the process boundary
    // (e.g. a deploy-target VALUE from the e2e harness) — the in-process
    // path runs directly.
    const dev: FrameworkCore.Framework["Service"]["dev"] = (devOptions) => {
      if (
        FrameworkCore.isInsideDevChild() ||
        !FrameworkCore.isJsonSerializable(options)
      ) {
        return inProcess.dev(devOptions);
      }
      const root = devOptions?.root ?? options?.root ?? process.cwd();
      const port = devOptions?.port ?? options?.port;
      return FrameworkCore.runDevChild({
        framework: "waku",
        module: "@alchemy.run/frontend-frameworks/waku",
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

    return FrameworkCore.Framework.of({ build: inProcess.build, dev });
  });

/**
 * The `Layer` form of {@link make} — the shape the e2e harness's framework
 * factory contract expects (`(options) => Layer<Framework>`).
 */
export const layer = (
  options?: WakuFrameworkOptions,
): Layer.Layer<
  FrameworkCore.Framework,
  never,
  FileSystem.FileSystem | Path.Path
> => Layer.effect(FrameworkCore.Framework, make(options));
