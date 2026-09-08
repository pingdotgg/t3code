import * as FrameworkCore from "../core/index.ts";
import {
  Framework,
  FrameworkError,
  type DeployTarget,
  type DeployTargetInput,
} from "../core/index.ts";
import type { Adapter } from "@sveltejs/kit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import type * as ViteModule from "vite";
import {
  DEFAULT_VITE_CONFIG_FILES,
  makeSvelteKitConfigPlugin,
} from "./UserConfig.ts";

/** The shape of the project's `@sveltejs/kit/vite` module. */
interface KitViteModule {
  readonly sveltekit: (
    config?: Record<string, unknown>,
  ) => Promise<ViteModule.PluginOption>;
}

/**
 * Adapter behavior a deploy target can configure without being consulted on
 * every write the adapter performs. The names mirror the knobs a static-asset
 * host exposes (fallback-page generation, the name of the binding the worker
 * shim serves assets through).
 */
export interface SvelteKitAdapterOptions {
  /**
   * Name of the static-assets binding the generated worker entry serves
   * files through.
   * @default "ASSETS"
   */
  readonly assetsBinding?: string | undefined;
  /**
   * Fallback-page behavior for requests that match no asset or route:
   * `"404-page"` writes `404.html`, `"single-page-application"` writes
   * `index.html` and additionally routes router-level not-founds on
   * navigation-shaped requests through the fallback (the Cloudflare
   * target's worker shim defers them to the assets layer).
   * @default "none"
   */
  readonly notFoundHandling?:
    | "none"
    | "404-page"
    | "single-page-application"
    | undefined;
  /**
   * With `notFoundHandling: "404-page"`: `"spa"` renders the app shell as the
   * fallback, `"plaintext"` writes a plain `Not Found` page.
   * @default "plaintext"
   */
  readonly fallback?: "spa" | "plaintext" | undefined;
}

/**
 * The configuration this package assembles from {@link SvelteKitOptions} and
 * hands to a deploy-target factory (see {@link SvelteKitTargetInput}). The
 * target treats it as its `DeployTarget.config`; the framework half never
 * inspects a resolved target's config.
 */
export interface SvelteKitTargetConfig {
  /** Compatibility date for the target's finishing pass. */
  readonly compatibilityDate?: string | undefined;
  /** Compatibility flags for the target's finishing pass. */
  readonly compatibilityFlags?: Array<string> | undefined;
  /** Adapter behavior (assets binding name, fallback generation). */
  readonly adapter?: SvelteKitAdapterOptions | undefined;
  /**
   * The kit config the framework half was constructed with
   * ({@link SvelteKitOptions.kit}). Carried on the target config so
   * wholesale targets that re-run the framework in a child process (the
   * AWS target — kit's postbuild workers require `cwd === root`) can
   * reconstruct the framework with the same options.
   */
  readonly kit?: Record<string, unknown> | undefined;
}

/** Inputs the framework passes when asking the target for a kit `Adapter`. */
export interface SvelteKitAdapterContext {
  /** Absolute project root. */
  readonly root: string;
  /**
   * Present when the adapter is constructed for the dev server: inputs for
   * the `platform` its `emulate()` must supply. Absent for production
   * builds.
   */
  readonly dev?:
    | {
        /**
         * Literal `platform.env` overrides — a same-named literal wins over
         * any target-provided platform value.
         */
        readonly env?: Record<string, unknown> | undefined;
        /**
         * Target-specific binding specs the dev platform should serve
         * (opaque to the framework half — e.g. the Cloudflare target takes
         * `cloudflare-runtime` binding hooks and proxies them onto
         * `platform.env`).
         */
        readonly bindings?: ReadonlyArray<unknown> | undefined;
        /**
         * A pre-built runtime-services context the dev platform hosts its
         * proxy in (opaque to the framework half; the Cloudflare target
         * takes a `cloudflare-runtime` `Context<RuntimeServices>`). Enables
         * remote()-lowered bindings; without it the platform is local-only.
         */
        readonly services?: unknown;
      }
    | undefined;
}

/** What a target's `adapt()` must record for the framework to continue. */
export interface SvelteKitAdapterResult {
  /**
   * The static-assets directory the adapter wrote (client build +
   * prerendered pages) — becomes `BuildOutput.clientDirectory`.
   */
  readonly dest: string;
  /**
   * Absolute path of the on-disk (unbundled) server entry the adapter
   * generated — passed to the target's `finish` pass as `context.entry`.
   */
  readonly workerEntry: string;
}

/**
 * A kit `Adapter` that records where it wrote its output. Every SvelteKit
 * deploy target's adapter must populate `result.current` from `adapt()`.
 */
export interface SvelteKitAdapter extends Adapter {
  readonly result: { current?: SvelteKitAdapterResult | undefined };
  /**
   * Release resources the adapter holds for the dev server (e.g. the
   * Cloudflare target's platform-proxy workerd instance). Called by the
   * framework after the dev server closes.
   */
  readonly dispose?: (() => Promise<void>) | undefined;
}

/**
 * A deploy target for SvelteKit: the generic `DeployTarget` seams plus the
 * one framework-specific hook kit needs — the `Adapter` instance to hand to
 * `sveltekit(config)`. The target's `finish` pass receives the adapter's
 * on-disk `workerEntry` (via `context.entry`) and is responsible for turning
 * it into `BuildOutput.serverModules` for the target runtime.
 */
export interface SvelteKitTarget extends DeployTarget<SvelteKitTargetConfig> {
  /** Produce the kit `Adapter` for one build/dev invocation. */
  readonly adapter: (context: SvelteKitAdapterContext) => SvelteKitAdapter;
}

/**
 * How a deploy target is passed to this package: a `SvelteKitTarget` value, a
 * factory `(config) => SvelteKitTarget`, or a module specifier resolved from
 * the *project's* `node_modules` (default-export — or named export `target` —
 * a value or factory).
 */
export type SvelteKitTargetInput = DeployTargetInput<
  SvelteKitTarget,
  SvelteKitTargetConfig
>;

/**
 * The default deploy target: this package's own Cloudflare Workers target
 * module (`src/cloudflare.ts`), loaded from the project's dependency tree.
 */
export const DEFAULT_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/sveltekit/cloudflare";

export interface SvelteKitOptions {
  /**
   * Project root. Must also be the process working directory: SvelteKit
   * resolves its peers (`vite`, `@sveltejs/vite-plugin-svelte`) relative to
   * `process.cwd()`.
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * The deploy target the build is produced for. Accepts a target value, a
   * `(config) => target` factory, or a module specifier string.
   * @default "@alchemy.run/frontend-frameworks/sveltekit/cloudflare"
   */
  readonly target?: SvelteKitTargetInput | undefined;
  /** Compatibility date forwarded to the target via its config. */
  readonly compatibilityDate?: string | undefined;
  /**
   * Compatibility flags forwarded to the target via its config. SvelteKit's
   * server graph is built for Node, so on workerd-style targets
   * `nodejs_compat` is effectively required.
   * @default ["nodejs_compat"] (applied by the Cloudflare target)
   */
  readonly compatibilityFlags?: Array<string> | undefined;
  /**
   * SvelteKit configuration for `sveltekit(config)` (kit v3 takes its config
   * via the Vite plugin; a `svelte.config.js` on disk is an upstream error).
   * When the project has its own `vite.config.ts`, these options are merged
   * over the ones passed to the user's `sveltekit(...)` call (integration
   * options win); construction-time options (`preprocess`, `extensions`,
   * `compilerOptions`, `vitePlugin`) can only be applied when no user config
   * file exists. The `adapter` field is always injected by this package.
   */
  readonly kit?: Record<string, unknown> | undefined;
  /** Extra Vite inline config merged into the build/dev config. */
  readonly vite?: ViteModule.InlineConfig | undefined;
  /** Adapter behavior forwarded to the target via its config. */
  readonly adapter?: SvelteKitAdapterOptions | undefined;
  readonly dev?:
    | {
        /** Default dev-server port (overridden by `FrameworkDevOptions.port`). */
        readonly port?: number | undefined;
        /**
         * Literal values exposed on the dev `platform.env`. Applied on top
         * of the values the target's dev platform serves for
         * {@link SvelteKitOptions.dev.bindings} — a same-named literal
         * always wins.
         */
        readonly env?: Record<string, unknown> | undefined;
        /**
         * Target-specific binding specs the dev platform should serve on
         * `platform.env`. Opaque to the framework half; the Cloudflare
         * target accepts `cloudflare-runtime` binding hooks (`Text.local`,
         * `KvNamespace.local`, …) and proxies them into kit's Node SSR via
         * a workerd-backed platform proxy.
         */
        readonly bindings?: ReadonlyArray<unknown> | undefined;
        /**
         * A pre-built runtime-services context the dev platform hosts its
         * proxy in (opaque to the framework half; the Cloudflare target
         * takes a `cloudflare-runtime` `Context<RuntimeServices>`). Enables
         * remote()-lowered bindings; without it the platform is local-only.
         */
        readonly services?: unknown;
      }
    | undefined;
}

const fail = (message: string, cause?: unknown) =>
  new FrameworkError({ framework: "sveltekit", message, cause });

/**
 * Pick the ESM target out of a package-exports entry (`"./x": "./file.js"` or
 * `"./x": { import: ..., default: ... }`, possibly nested conditions).
 */
export const resolveExportTarget = (entry: unknown): string | undefined => {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry !== null && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    for (const condition of ["import", "default"]) {
      if (condition in record) {
        const target = resolveExportTarget(record[condition]);
        if (target !== undefined) {
          return target;
        }
      }
    }
  }
  return undefined;
};

/** Path segment identifying an id inside an `@sveltejs/kit` package. */
const KIT_PACKAGE_MARKER = "/@sveltejs/kit/";

/**
 * Re-anchor kit-runtime module ids that were resolved against the wrong
 * base directory.
 *
 * SvelteKit's route manifest stores its fallback root components
 * (`<kit>/src/runtime/components/{layout,error}.svelte`) as paths RELATIVE
 * to the Vite root, but resolves them against `process.cwd()`: the dev
 * server's node loader calls `path.resolve(id)`, and the generated
 * client/server modules embed `path.relative(absoluteBase, relativeId)`
 * output (whose `relativeId` is resolved against the cwd). Kit therefore
 * assumes `process.cwd() === root`. When the dev server is driven
 * programmatically from another directory — alchemy's dev sidecar, a
 * monorepo root — those ids re-root outside the project and every SSR
 * request 500s with `Failed to load url
 * /@fs/<wrong-base>/.../@sveltejs/kit/src/runtime/components/layout.svelte`.
 *
 * This plugin remaps exactly those casualties: an id that points inside an
 * `@sveltejs/kit` package directory but does NOT exist on disk is re-rooted
 * onto the project's real kit installation. Ids that resolve to an existing
 * file are never touched.
 */
const makeKitRuntimeRealignPlugin = (
  kitDirectory: string,
): ViteModule.Plugin => {
  const realign = (candidate: string, query: string): string | undefined => {
    if (NodeFs.existsSync(candidate)) {
      return undefined;
    }
    const normalized = candidate.replaceAll("\\", "/");
    const index = normalized.lastIndexOf(KIT_PACKAGE_MARKER);
    if (index === -1) {
      return undefined;
    }
    const remapped = NodePath.join(
      kitDirectory,
      normalized.slice(index + KIT_PACKAGE_MARKER.length),
    );
    return NodeFs.existsSync(remapped) ? remapped + query : undefined;
  };
  return {
    name: "distilled-sveltekit-kit-runtime-realign",
    enforce: "pre",
    resolveId(source, importer) {
      if (!source.includes("@sveltejs")) {
        return undefined;
      }
      const queryIndex = source.indexOf("?");
      const bare = queryIndex === -1 ? source : source.slice(0, queryIndex);
      const query = queryIndex === -1 ? "" : source.slice(queryIndex);
      if (bare.startsWith("/@fs/")) {
        // Vite serves absolute fs paths as `/@fs/<path>` (`/@fs/C:/...` on
        // Windows — strip the extra leading slash before a drive letter).
        const fsPath = bare.slice("/@fs".length);
        return realign(
          /^\/[A-Za-z]:[/\\]/.test(fsPath) ? fsPath.slice(1) : fsPath,
          query,
        );
      }
      if (NodePath.isAbsolute(bare)) {
        return realign(bare, query);
      }
      if (bare.startsWith(".") && importer !== undefined) {
        const importerPath = importer.split("?")[0] ?? importer;
        return realign(
          NodePath.resolve(NodePath.dirname(importerPath), bare),
          query,
        );
      }
      return undefined;
    },
  };
};

/**
 * Build the `Framework` service implementation for a SvelteKit project.
 *
 * - `build` resolves the deploy target, then either delegates wholesale
 *   (`target.build`) or runs kit's production build via programmatic Vite
 *   (`createBuilder().buildApp()`) with the target-provided adapter and hands
 *   the adapter's on-disk worker entry to the target's `finish` pass, which
 *   produces the final `BuildOutput.serverModules`. A project-owned
 *   `vite.config.ts` loads natively (the user's `sveltekit(...)` call and
 *   plugins apply; the target's adapter is injected into it — see
 *   `UserConfig.ts`); without one, the config is fully programmatic.
 * - `dev` runs kit's own Vite dev server (Node SSR, full HMR) with the
 *   target-provided adapter supplying the `platform` emulation.
 *
 * This module is target-agnostic: everything Cloudflare-specific lives in
 * `@alchemy.run/frontend-frameworks/sveltekit/cloudflare`.
 */
export const make: (
  options?: SvelteKitOptions,
) => Effect.Effect<
  Framework["Service"],
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (options?: SvelteKitOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseRoot = options?.root ?? (yield* Effect.sync(() => process.cwd()));

  const targetConfig: SvelteKitTargetConfig = {
    compatibilityDate: options?.compatibilityDate,
    compatibilityFlags: options?.compatibilityFlags,
    adapter: options?.adapter,
    kit: options?.kit,
  };

  const resolveTarget = (root: string) =>
    FrameworkCore.resolveDeployTarget<SvelteKitTarget, SvelteKitTargetConfig>(
      root,
      options?.target ?? DEFAULT_TARGET_SPECIFIER,
      targetConfig,
    ).pipe(Effect.mapError((error) => fail(error.message, error.cause)));

  const requireAdapterHook = (target: SvelteKitTarget) =>
    typeof target.adapter === "function"
      ? Effect.succeed(target)
      : Effect.fail(
          fail(
            `The resolved "${target.platform}" deploy target does not implement the SvelteKit ` +
              "adapter hook (`adapter(context)`) and has no wholesale `build`",
          ),
        );

  const loadVite = (root: string) =>
    FrameworkCore.loadProjectModule<typeof ViteModule>(root, "vite").pipe(
      Effect.mapError((error) =>
        fail("Failed to load the project's Vite", error.cause),
      ),
    );

  const resolveKitDirectory = (root: string) =>
    FrameworkCore.resolveProjectPackageDirectory(root, "@sveltejs/kit").pipe(
      Effect.mapError((error) =>
        fail("Failed to locate the project's @sveltejs/kit", error.cause),
      ),
    );

  // `@sveltejs/kit`'s `./vite` export carries only an `import` condition, so
  // framework-core's `createRequire().resolve` dance cannot resolve it.
  // Resolve the package directory (via its universally-exported
  // `./package.json`) and walk the exports map instead.
  const loadKitViteModule = Effect.fn(function* (root: string) {
    const kitDirectory = yield* resolveKitDirectory(root);
    const manifest = yield* fs
      .readFileString(path.join(kitDirectory, "package.json"))
      .pipe(
        Effect.mapError((error) =>
          fail("Failed to read @sveltejs/kit's package.json", error),
        ),
      );
    const parsed = yield* Effect.try({
      try: () => JSON.parse(manifest) as { exports?: Record<string, unknown> },
      catch: (error) =>
        fail("Failed to parse @sveltejs/kit's package.json", error),
    });
    const target = resolveExportTarget(parsed.exports?.["./vite"]);
    if (target === undefined) {
      return yield* Effect.fail(
        fail(
          `The project's @sveltejs/kit (${kitDirectory}) has no "./vite" export`,
        ),
      );
    }
    return yield* Effect.tryPromise({
      try: async () =>
        (await import(
          /* @vite-ignore */ pathToFileURL(path.join(kitDirectory, target)).href
        )) as KitViteModule,
      catch: (error) =>
        fail("Failed to load the project's @sveltejs/kit/vite", error),
    });
  });

  const loadKitPlugins = Effect.fn(function* (root: string, adapter: Adapter) {
    const kitVite = yield* loadKitViteModule(root);
    return yield* Effect.tryPromise({
      try: async () => await kitVite.sveltekit({ ...options?.kit, adapter }),
      catch: (error) => fail("Failed to construct the SvelteKit plugin", error),
    });
  });

  const findViteConfigFile = Effect.fnUntraced(function* (root: string) {
    for (const name of DEFAULT_VITE_CONFIG_FILES) {
      const exists = yield* fs
        .exists(path.join(root, name))
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));
      if (exists) {
        return name;
      }
    }
    return undefined;
  });

  /**
   * Assemble the Vite inline config for a build/dev invocation.
   *
   * - Project has its own Vite config file: the file loads natively
   *   (`configFile` is left to Vite's discovery — the user's plugins,
   *   including their `sveltekit(...)` call, all apply) and the inline
   *   config only injects `makeSvelteKitConfigPlugin`, which installs the
   *   deploy target's adapter (and `options.kit` overrides) into the
   *   user's kit config before kit processes it.
   * - No config file on disk: internal fallback — `configFile: false` with
   *   the `sveltekit()` plugin constructed programmatically from
   *   `options.kit` + the target's adapter.
   */
  const resolveViteConfig = Effect.fn(function* (
    root: string,
    adapter: Adapter,
  ) {
    // Kit resolves the manifest's `..`-relative fallback-component ids
    // against `process.cwd()` instead of the Vite root; the realign plugin
    // repairs them when the two differ (see makeKitRuntimeRealignPlugin).
    const realign = makeKitRuntimeRealignPlugin(
      yield* resolveKitDirectory(root),
    );
    const userConfigFile = yield* findViteConfigFile(root);
    if (userConfigFile === undefined) {
      const plugins = yield* loadKitPlugins(root, adapter);
      return {
        root,
        configFile: false,
        // Default to warn: rolldown-vite's native progress reporter
        // ("transforming...") writes straight to the fd, which corrupts
        // hosting-process reporters (e.g. alchemy-test) that can only
        // intercept JS-level writers.
        logLevel: "warn",
        ...options?.vite,
        plugins: [realign, ...(options?.vite?.plugins ?? []), plugins],
      } satisfies ViteModule.InlineConfig;
    }
    return {
      root,
      logLevel: "warn",
      ...options?.vite,
      plugins: [
        realign,
        ...(options?.vite?.plugins ?? []),
        makeSvelteKitConfigPlugin({ adapter, kit: options?.kit }),
      ],
    } satisfies ViteModule.InlineConfig;
  });

  const build: Framework["Service"]["build"] = Effect.fn(
    function* (buildOptions) {
      const root = buildOptions?.root ?? baseRoot;
      const target = yield* resolveTarget(root);
      const targetContext = {
        root,
        framework: "sveltekit",
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

      yield* requireAdapterHook(target);
      const adapter = target.adapter({ root });
      const vite = yield* loadVite(root);
      const config = yield* resolveViteConfig(root, adapter);

      yield* Effect.tryPromise({
        try: async () => {
          const builder = await vite.createBuilder(config, null);
          await builder.buildApp();
        },
        catch: (error) => fail("Failed to build", error),
      });

      const result = adapter.result.current;
      if (result === undefined) {
        return yield* Effect.fail(
          fail("The SvelteKit build completed without running the adapter"),
        );
      }

      const output: FrameworkCore.BuildOutput = {
        distDirectory: path.resolve(root, "dist"),
        clientDirectory: result.dest,
        serverModules: undefined,
        externalWorkspaces: new Set<string>(),
      };

      // The target's finishing pass turns the adapter's on-disk worker entry
      // into runtime-ready server modules (e.g. the Cloudflare target's
      // rolldown re-bundle for workerd).
      return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
        ...targetContext,
        entry: result.workerEntry,
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
      const target = yield* resolveTarget(root);
      yield* requireAdapterHook(target);
      const adapter = target.adapter({
        root,
        dev: {
          env: options?.dev?.env,
          bindings: options?.dev?.bindings,
          services: options?.dev?.services,
        },
      });
      // Registered before the server is acquired so it runs after the server
      // closes (finalizers are LIFO): the dev platform (e.g. the Cloudflare
      // target's platform proxy) outlives the last in-flight request.
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          try {
            await adapter.dispose?.();
          } catch {
            // dev-platform teardown is best-effort
          }
        }),
      );
      const vite = yield* loadVite(root);
      const config = yield* resolveViteConfig(root, adapter);
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
              ...config,
              server: {
                ...config.server,
                port,
                ...(host !== undefined ? { host } : undefined),
              },
            });
            return await server.listen();
          },
          catch: (error) => fail("Failed to start the dev server", error),
        }),
        (server) => Effect.promise(async () => await server.close()),
      );
      const url = server.resolvedUrls?.local[0];
      if (url === undefined) {
        return yield* Effect.fail(
          fail("Could not determine the dev server URL"),
        );
      }
      return { url };
    },
  );

  // Constructing the SvelteKit plugin loads the project's `@sveltejs/kit`
  // module graph, which misbehaves when several projects load it
  // concurrently in one process (partially-initialized module bindings —
  // `Cannot access 'kit_options' before initialization`). A process hosting
  // many sites' dev servers (the alchemy dev sidecar) hits exactly that, so
  // run the dev server in a dedicated child process instead (see
  // core/DevChild.ts). Inside that child — or when the options cannot cross
  // the process boundary (deploy-target VALUES, live vite plugins from the
  // e2e harness) — the in-process path runs directly.
  const dev: Framework["Service"]["dev"] = (devOptions) => {
    if (
      FrameworkCore.isInsideDevChild() ||
      !FrameworkCore.isJsonSerializable(options)
    ) {
      return devInProcess(devOptions);
    }
    const root = devOptions?.root ?? baseRoot;
    const port = devOptions?.port ?? options?.dev?.port;
    return FrameworkCore.runDevChild({
      framework: "sveltekit",
      module: "@alchemy.run/frontend-frameworks/sveltekit",
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

/**
 * A `Layer` providing framework-core's `Framework` service for a SvelteKit
 * project — the fully-typed entrypoint for `e2e.config.ts` (harness form 4)
 * and alchemy's `Website.SvelteKit` composite.
 */
export const layer = (
  options?: SvelteKitOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Framework, make(options));
