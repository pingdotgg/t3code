import * as FrameworkCore from "../core/index.ts";
import {
  Framework,
  FrameworkError,
  type DeployTarget,
  type DeployTargetError,
  type DeployTargetInput,
} from "../core/index.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import {
  enforceNitroConfig,
  findPresetConflict,
  makeNuxtOverrides,
  presetConflictMessage,
  type NitroConfigSlice,
  type NuxtConfigLayer,
} from "./UserConfig.ts";

/**
 * The structural slice of the project's `@nuxt/kit` module this package
 * drives. Typed structurally so the package carries no dependency on
 * `@nuxt/kit` — the *project's* install is always the one loaded.
 */
export interface NuxtKitModule {
  readonly loadNuxt: (options: {
    readonly cwd: string;
    readonly dev?: boolean;
    readonly ready?: boolean;
    readonly overrides?: Record<string, unknown>;
  }) => Promise<NuxtInstance>;
  readonly buildNuxt: (nuxt: NuxtInstance) => Promise<unknown>;
}

/** The structural slice of a loaded Nuxt instance this package reads. */
export interface NuxtInstance {
  readonly options: {
    readonly _layers?: ReadonlyArray<NuxtConfigLayer> | undefined;
    readonly [key: string]: unknown;
  };
  readonly hook: (
    name: string,
    fn: (...args: Array<never>) => unknown,
  ) => unknown;
  readonly ready: () => Promise<void>;
  readonly close: () => Promise<void>;
  /**
   * The dev middleware server (nitro's dev server; present after `ready()`
   * when loaded with `dev: true`). `listen` is listhen-backed: it binds a
   * real HTTP listener serving the dev app.
   */
  readonly server?:
    | {
        readonly listen: (
          port: number,
          opts?: { readonly hostname?: string },
        ) => Promise<NuxtDevListener>;
      }
    | undefined;
}

/** The structural slice of the listhen listener `nuxt.server.listen` returns. */
export interface NuxtDevListener {
  readonly url?: string | undefined;
  readonly close?: (() => Promise<void>) | undefined;
}

/** The structural slice of a Nitro instance (`nitro:init` hook payload). */
interface NitroInstanceSlice {
  readonly options: {
    entry?: string;
    readonly output: {
      readonly dir: string;
      readonly serverDir: string;
      readonly publicDir: string;
    };
  };
}

/** Inputs the framework passes when consulting the target's nitro hook. */
export interface NuxtNitroContext {
  /** Absolute project root. */
  readonly root: string;
  /**
   * Absolute path of the USER's worker entry (the generic user-entry seam,
   * `target.entry` resolved against the root), when one is configured. The
   * target maps it onto nitro's entry/exports seam — the user module wraps
   * nitro's emitted handler and adds its own exports (Durable Objects, ...).
   */
  readonly entry?: string | undefined;
}

/**
 * The configuration this package assembles from {@link NuxtOptions} and hands
 * to a deploy-target factory. The target treats it as its
 * `DeployTarget.config`; the framework half never inspects a resolved
 * target's config.
 */
export interface NuxtTargetConfig {
  /** Compatibility date the target carries for serve/deploy. */
  readonly compatibilityDate?: string | undefined;
  /** Compatibility flags the target carries for serve/deploy. */
  readonly compatibilityFlags?: Array<string> | undefined;
  /**
   * The USER's worker entry (the custom-entry carriage): a module that wraps
   * nitro's emitted entry and adds its own exports (Durable Object classes,
   * ...). Relative paths resolve against the project root.
   */
  readonly main?: string | undefined;
  /**
   * Whether the server build includes Node.js compatibility (nitro's hybrid
   * workerd node-compat). The deployed worker must enable the
   * `nodejs_compat` compatibility flag when this is on.
   * @default true (applied by the Cloudflare target)
   */
  readonly nodeCompat?: boolean | undefined;
  /**
   * The nuxt config overrides the framework half was constructed with
   * ({@link NuxtOptions.nuxt}). Carried on the target config so wholesale
   * targets that re-run the framework in a child process (the AWS target —
   * `loadNuxt` executes user config/modules that may mutate the process)
   * can reconstruct the framework with the same options.
   */
  readonly nuxt?: Record<string, unknown> | undefined;
}

/** Inputs the framework passes when asking the target for its dev platform. */
export interface NuxtDevPlatformContext {
  /** Absolute project root. */
  readonly root: string;
  /**
   * Literal env overrides for the dev platform — a same-named literal wins
   * over any platform-served value.
   */
  readonly env?: Record<string, unknown> | undefined;
  /**
   * Target-specific binding specs the dev platform should serve (opaque to
   * the framework half — the Cloudflare target takes `cloudflare-runtime`
   * binding hooks and serves them through its platform proxy).
   */
  readonly bindings?: ReadonlyArray<unknown> | undefined;
  /**
   * Pre-built runtime-services context for the dev platform's proxy (opaque
   * to the framework half — see `NuxtOptions.dev.services`).
   */
  readonly services?: unknown;
}

/**
 * What a target's dev platform contributes to the dev server: extra nitro
 * plugins and `runtimeConfig` to inject through the `loadNuxt` overrides
 * (the Cloudflare target injects its `event.context.cloudflare` bridge
 * plugin plus the platform-proxy connect info).
 */
export interface NuxtDevPlatform {
  /** Absolute paths of nitro plugins to inject into the dev server. */
  readonly nitroPlugins?: ReadonlyArray<string> | undefined;
  /** `runtimeConfig` injected over the integration overrides. */
  readonly runtimeConfig?: Record<string, unknown> | undefined;
}

/**
 * A deploy target for Nuxt: the generic `DeployTarget` seams plus the
 * framework-specific hooks nitro-driven builds and dev servers need — the
 * nitro deployment preset to build with, a last-word pass over the resolved
 * nitro config, and the dev-platform seam.
 */
export interface NuxtTarget extends DeployTarget<NuxtTargetConfig> {
  /** The nitro deployment preset this target builds with (e.g. `"cloudflare_module"`). */
  readonly nitroPreset: string;
  /**
   * Last-word mutation of the resolved nitro config, run from the
   * `nitro:config` hook after the user's config, layers, and modules have
   * all contributed (e.g. the Cloudflare target forces
   * `cloudflare.deployConfig: false` and wires the user entry).
   */
  readonly configureNitro?:
    | ((nitroConfig: NitroConfigSlice, context: NuxtNitroContext) => void)
    | undefined;
  /**
   * The target's dev-platform story: acquire whatever serves the platform
   * environment in dev (scoped — closing the Scope tears it down AFTER the
   * dev server closes) and return the injection the dev server needs. When
   * absent, `dev` runs the plain framework dev server with no platform
   * bridge.
   */
  readonly devPlatform?:
    | ((
        context: NuxtDevPlatformContext,
      ) => Effect.Effect<NuxtDevPlatform, DeployTargetError, Scope.Scope>)
    | undefined;
}

/**
 * How a deploy target is passed to this package: a `NuxtTarget` value, a
 * factory `(config) => NuxtTarget`, or a module specifier resolved from the
 * *project's* `node_modules` (default-export — or named export `target` — a
 * value or factory).
 */
export type NuxtTargetInput = DeployTargetInput<NuxtTarget, NuxtTargetConfig>;

/**
 * The default deploy target: this package's own Cloudflare Workers target
 * module (`src/cloudflare.ts`), loaded from the project's dependency tree.
 */
export const DEFAULT_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/nuxt/cloudflare";

export interface NuxtOptions {
  /**
   * Project root (the directory containing `nuxt.config.ts`).
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * The deploy target the build is produced for. Accepts a target value, a
   * `(config) => target` factory, or a module specifier string.
   * @default "@alchemy.run/frontend-frameworks/nuxt/cloudflare"
   */
  readonly target?: NuxtTargetInput | undefined;
  /** Compatibility date forwarded to the target via its config. */
  readonly compatibilityDate?: string | undefined;
  /**
   * Compatibility flags forwarded to the target via its config. Nitro's
   * workerd build uses hybrid Node.js compatibility, so on workerd-style
   * targets `nodejs_compat` is effectively required.
   * @default ["nodejs_compat"] (applied by the Cloudflare target)
   */
  readonly compatibilityFlags?: Array<string> | undefined;
  /**
   * The USER's worker entry (the custom-entry carriage — see
   * {@link NuxtTargetConfig.main}). Relative paths resolve against the root.
   */
  readonly main?: string | undefined;
  /**
   * Nuxt config overrides merged over the project's own `nuxt.config.ts`
   * (highest-priority c12 layer; integration wins). The user's file remains
   * authoritative for everything not named here; `nitro.preset` is always
   * owned by the deploy target.
   */
  readonly nuxt?: Record<string, unknown> | undefined;
  readonly dev?:
    | {
        /** Default dev-server port (overridden by `FrameworkDevOptions.port`). */
        readonly port?: number | undefined;
        /**
         * Literal values exposed on the dev platform env
         * (`event.context.cloudflare.env` on the Cloudflare target).
         * Applied on top of the values served for {@link bindings} — a
         * same-named literal always wins.
         */
        readonly env?: Record<string, unknown> | undefined;
        /**
         * Target-specific binding specs the dev platform should serve.
         * Opaque to the framework half; the Cloudflare target accepts
         * `cloudflare-runtime` binding hooks (`Text.local`,
         * `KvNamespace.local`, …) and serves them into nitro's dev SSR
         * worker thread through a workerd-backed platform proxy.
         */
        readonly bindings?: ReadonlyArray<unknown> | undefined;
        /**
         * A pre-built runtime-services context the dev platform should host
         * its proxy in (opaque to the framework half; the Cloudflare target
         * takes a `cloudflare-runtime` `Context<RuntimeServices>`). Embedders
         * that already run a runtime stack — alchemy's dev sidecar — pass it
         * so remote()-lowered bindings resolve; without it the platform is
         * local-only.
         */
        readonly services?: unknown;
      }
    | undefined;
}

const fail = (message: string, cause?: unknown) =>
  new FrameworkError({ framework: "nuxt", message, cause });

/**
 * The specifier the project's Nuxt kit is loaded from. `@nuxt/kit` itself is
 * not directly resolvable from a project root under isolated installs (it's
 * nuxt's own dependency), but nuxt's universally-present `./kit` subpath
 * (`nuxt/kit.js`, a plain `export * from "@nuxt/kit"`) is — and it resolves
 * the project's own kit instance.
 */
export const NUXT_KIT_SPECIFIER = "nuxt/kit";

/**
 * Build the `Framework` service implementation for a Nuxt project.
 *
 * - `build` resolves the deploy target, then either delegates wholesale
 *   (`target.build`) or drives the PROJECT's `@nuxt/kit` programmatically:
 *   `loadNuxt({ cwd, dev: false, ready: false, overrides })` — the project's
 *   `nuxt.config.ts` loads natively through c12 — hooks are registered
 *   BEFORE `nuxt.ready()` (with `ready: true` they'd fire inside `loadNuxt`
 *   and be missed), then `buildNuxt`. The nitro preset is the target's
 *   (`nitro:config` gets the last word); a user-configured foreign preset
 *   fails with an actionable error. The `BuildOutput` is read from nitro's
 *   `.output`: `serverModules` entry-first from `.output/server`,
 *   `clientDirectory` = `.output/public`, both taken from the resolved
 *   nitro output options (`nitro:init`).
 * - `dev` runs Nuxt's own dev server programmatically (`loadNuxt({ dev:
 *   true, ready: false })` → hooks → `ready()` → `nuxt.server.listen` →
 *   `buildNuxt`, the same flow `nuxi dev` drives), scoped — closing the
 *   Scope closes the listener, the Nuxt instance, and then the target's
 *   dev platform. The target's `devPlatform` seam contributes nitro
 *   plugins + `runtimeConfig` (the Cloudflare target injects its
 *   `event.context.cloudflare` bridge served through cloudflare-runtime's
 *   platform proxy — SSR runs in nitro's Node worker THREAD, wrangler-free).
 *
 * This module is target-agnostic: everything Cloudflare-specific lives in
 * `@alchemy.run/frontend-frameworks/nuxt/cloudflare`.
 */
export const make: (
  options?: NuxtOptions,
) => Effect.Effect<
  Framework["Service"],
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (options?: NuxtOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseRoot = options?.root ?? (yield* Effect.sync(() => process.cwd()));

  const targetConfig: NuxtTargetConfig = {
    compatibilityDate: options?.compatibilityDate,
    compatibilityFlags: options?.compatibilityFlags,
    main: options?.main,
    nuxt: options?.nuxt,
  };

  const resolveTarget = (root: string) =>
    FrameworkCore.resolveDeployTarget<NuxtTarget, NuxtTargetConfig>(
      root,
      options?.target ?? DEFAULT_TARGET_SPECIFIER,
      targetConfig,
    ).pipe(Effect.mapError((error) => fail(error.message, error.cause)));

  const requireNitroPreset = (target: NuxtTarget) =>
    typeof target.nitroPreset === "string" && target.nitroPreset.length > 0
      ? Effect.succeed(target)
      : Effect.fail(
          fail(
            `The resolved "${target.platform}" deploy target does not declare the nitro ` +
              "preset hook (`nitroPreset`) and has no wholesale `build`",
          ),
        );

  const loadNuxtKit = (root: string) =>
    FrameworkCore.loadProjectModule<NuxtKitModule>(
      root,
      NUXT_KIT_SPECIFIER,
    ).pipe(
      Effect.mapError((error) =>
        fail("Failed to load the project's Nuxt kit", error.cause),
      ),
    );

  const build: Framework["Service"]["build"] = Effect.fn(
    function* (buildOptions) {
      const root = buildOptions?.root ?? baseRoot;
      const target = yield* resolveTarget(root);
      const targetContext = { root, framework: "nuxt", env: buildOptions?.env };

      // Wholesale build takeover (targets that own the entire pipeline).
      if (target.build !== undefined) {
        return yield* target.build(targetContext).pipe(
          Effect.mapError((error) => fail(error.message, error.cause)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }

      yield* requireNitroPreset(target);
      const entry = FrameworkCore.resolveDeployTargetEntry(target, { root });
      const kit = yield* loadNuxtKit(root);

      // The user's nuxt.config.ts loads natively; our injection rides the
      // highest-priority overrides layer. `ready: false` so hooks registered
      // below actually fire (ready: true runs them inside loadNuxt).
      const nuxt = yield* Effect.tryPromise({
        try: async () =>
          await kit.loadNuxt({
            cwd: root,
            dev: false,
            ready: false,
            overrides: makeNuxtOverrides({
              nitroPreset: target.nitroPreset,
              nuxtConfig: options?.nuxt,
            }),
          }),
        catch: (error) => fail("Failed to load the Nuxt project", error),
      });

      const buildResult = yield* Effect.gen(function* () {
        // Conflict policy: the overrides layer shadows a user-set preset in
        // the merged options, so the user's raw value is read from the
        // project's own config layers and rejected with an actionable error
        // instead of being silently replaced.
        const conflict = findPresetConflict(
          nuxt.options._layers,
          target.nitroPreset,
        );
        if (conflict !== undefined) {
          return yield* Effect.fail(
            fail(presetConflictMessage(conflict, target.nitroPreset)),
          );
        }

        // Registered BEFORE nuxt.ready(): nitro:config fires while ready()
        // initializes nitro.
        let outputDirs: NitroInstanceSlice["options"]["output"] | undefined;
        yield* Effect.sync(() => {
          nuxt.hook("nitro:config", (nitroConfig: NitroConfigSlice) => {
            enforceNitroConfig(nitroConfig, {
              preset: target.nitroPreset,
              configure: (config) =>
                target.configureNitro?.(config, { root, entry }),
            });
          });
          nuxt.hook("nitro:init", (nitro: NitroInstanceSlice) => {
            outputDirs = nitro.options.output;
            // The user-entry seam: nitro bundles `options.entry` as THE
            // worker entry, so the user module's exports (default handler +
            // Durable Objects, ...) are the worker's exports. Set on the
            // INSTANCE options — not the nitro config — because nitro's
            // prerenderer clones `options._config` for its Node-preset
            // sub-build, and a workerd-flavored user entry (importing
            // `cloudflare:` modules) must not leak into that clone.
            if (entry !== undefined) {
              nitro.options.entry = entry;
            }
          });
        });

        yield* Effect.tryPromise({
          try: async () => {
            await nuxt.ready();
            await kit.buildNuxt(nuxt);
          },
          catch: (error) => fail("Failed to build", error),
        });

        const output = outputDirs ?? {
          dir: path.resolve(root, ".output"),
          serverDir: path.resolve(root, ".output", "server"),
          publicDir: path.resolve(root, ".output", "public"),
        };
        return output;
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            try {
              await nuxt.close();
            } catch {
              // teardown is best-effort
            }
          }),
        ),
      );

      const output = yield* readNitroOutput(buildResult).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      // The finishing-pass seam (none needed for cloudflare_module — the
      // output is already workerd ESM — but the contract is honored for
      // targets that do post-process).
      return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
        ...targetContext,
        entry: path.join(buildResult.serverDir, "index.mjs"),
      }).pipe(
        Effect.mapError((error) => fail(error.message, error.cause)),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    },
  );

  const dev: Framework["Service"]["dev"] = Effect.fn(function* (devOptions) {
    const root = devOptions?.root ?? baseRoot;
    const target = yield* resolveTarget(root);
    // Resolve the project's kit before anything expensive: a root without
    // a Nuxt install fails fast, without spawning the dev platform.
    const kit = yield* loadNuxtKit(root);

    // The dev platform is acquired BEFORE the server so its finalizer
    // runs LAST (finalizers are LIFO): the platform (e.g. the Cloudflare
    // target's platform-proxy workerd instance) outlives the last
    // in-flight request of the closing dev server.
    const platform =
      target.devPlatform !== undefined
        ? yield* target
            .devPlatform({
              root,
              env: options?.dev?.env,
              bindings: options?.dev?.bindings,
              services: options?.dev?.services,
            })
            .pipe(Effect.mapError((error) => fail(error.message, error.cause)))
        : undefined;

    // The user's nuxt.config.ts loads natively; the dev injection rides
    // the overrides layer. No nitro preset here — nitro's dev flow runs
    // its own Node dev preset (the SSR worker thread); the deploy preset
    // only matters for `build`. Telemetry/devtools are disabled: this
    // dev server runs headless under alchemy / the e2e harness.
    //
    // Injected plugins live under node_modules (this package's dist), so
    // their directories must be forced into `nitro.externals.inline`:
    // nitro's externals pass would otherwise keep the plugin external and
    // node would resolve its `nitropack/runtime` import against the raw
    // package, whose `#nitro-internal-virtual/*` imports only exist
    // inside the dev bundle.
    const nitroPlugins = platform?.nitroPlugins;
    const nuxt = yield* Effect.tryPromise({
      try: async () =>
        await kit.loadNuxt({
          cwd: root,
          dev: true,
          ready: false,
          overrides: makeNuxtOverrides({
            nuxtConfig: {
              telemetry: false,
              devtools: { enabled: false },
              ...options?.nuxt,
            },
            nitroPlugins,
            nitroExternalsInline: nitroPlugins?.map((plugin) =>
              path.dirname(plugin),
            ),
            runtimeConfig: platform?.runtimeConfig,
          }),
        }),
      catch: (error) => fail("Failed to load the Nuxt project", error),
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        try {
          await nuxt.close();
        } catch {
          // teardown is best-effort
        }
      }),
    );

    yield* Effect.tryPromise({
      try: () => nuxt.ready(),
      catch: (error) => fail("Failed to initialize the Nuxt dev server", error),
    });

    const server = nuxt.server;
    if (server === undefined || typeof server.listen !== "function") {
      return yield* Effect.fail(
        fail(
          "The loaded Nuxt instance exposes no dev server (`nuxt.server.listen`)",
        ),
      );
    }
    // `nuxt.server.listen` is listhen-backed. listhen hunts upward from
    // 3000 when NO port is given — colliding with (or IPv6-shadowing)
    // user-facing `alchemy dev` proxy ports — while an explicit `port: 0`
    // resolves to get-port-please's `getRandomPort`, the same
    // probe-and-release `findEphemeralPort` does. Probe explicitly for
    // uniformity with the Vite-based frameworks (see DevPort's TODO).
    const port =
      (devOptions?.port ?? options?.dev?.port) ||
      (yield* FrameworkCore.findEphemeralPort());
    const host = devOptions?.host;
    const listener = yield* Effect.acquireRelease(
      Effect.tryPromise({
        // Nitro's dev-server `listen` is listhen-backed; the second
        // argument merges into listhen's options (older versions ignore
        // it, degrading to the default host).
        try: () =>
          server.listen(
            port,
            host !== undefined ? { hostname: host } : undefined,
          ),
        catch: (error) =>
          fail("Failed to start the dev server listener", error),
      }),
      (listener) =>
        Effect.promise(async () => {
          try {
            await listener.close?.();
          } catch {
            // teardown is best-effort
          }
        }),
    );
    const url = listener.url;
    if (url === undefined) {
      return yield* Effect.fail(fail("Could not determine the dev server URL"));
    }

    // The initial dev build — same flow as `nuxi dev` (which awaits
    // buildNuxt after wiring its listener); the promise resolves once
    // the dev bundles are ready, watchers keep running in background.
    yield* Effect.tryPromise({
      try: () => kit.buildNuxt(nuxt),
      catch: (error) => fail("Failed to build the dev server", error),
    });

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

/** The nitro server entry's module name within the `BuildOutput` (POSIX). */
export const SERVER_ENTRY_NAME = "server/index.mjs";

/** The resolved nitro output directories (`nitro.options.output`). */
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
 * sha256-hashed), `clientDirectory` = the public directory. The
 * `cloudflare_module` output is already self-contained workerd ESM — no
 * finishing pass, and no external workspace roots (nitro inlines workspace
 * imports into the server chunks).
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
        fail(`The Nuxt build produced no server modules in ${dirs.serverDir}`),
      );
    }
    const serverModules = FrameworkCore.sortServerModules(
      modules,
      SERVER_ENTRY_NAME,
    );
    if (serverModules[0]?.name !== SERVER_ENTRY_NAME) {
      return yield* Effect.fail(
        fail(
          `The Nuxt build produced no "${SERVER_ENTRY_NAME}" entry in ${dirs.serverDir}`,
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
 * A `Layer` providing framework-core's `Framework` service for a Nuxt
 * project — the fully-typed entrypoint for `e2e.config.ts` (harness form 4)
 * and alchemy's `Website.Nuxt` composite.
 */
export const layer = (
  options?: NuxtOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Framework, make(options));
