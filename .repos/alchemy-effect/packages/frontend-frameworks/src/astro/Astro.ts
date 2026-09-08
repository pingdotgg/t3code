import * as FrameworkCore from "../core/index.ts";
import type { AstroInlineConfig, AstroIntegration } from "astro";
import type * as AstroNamespace from "astro";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as ViteModule from "vite";
import { NODE_ENVIRONMENTS } from "./environments.ts";
import {
  DEFAULT_TARGET_SPECIFIER,
  isAstroTarget,
  type AstroTarget,
  type AstroTargetInput,
} from "./Target.ts";

type AstroModule = typeof AstroNamespace;

/**
 * Options for the Astro `Framework` integration. The deploy target is passed
 * as a value (`target`), keeping this module platform-neutral: all
 * platform-specific behavior (adapter/integration selection, bundler plugin
 * injection, dev SSR execution) lives in the target module.
 */
export interface AstroFrameworkOptions<TargetConfig = unknown> {
  /**
   * The deploy target: an `AstroTarget` value, a `(config) => AstroTarget`
   * factory, or a module specifier resolved from the project's own
   * `node_modules`. Defaults to this package's Cloudflare target module
   * (`"@alchemy.run/frontend-frameworks/astro/cloudflare"`). Factories and specifiers are
   * applied to {@link targetConfig}.
   */
  readonly target?: AstroTargetInput<TargetConfig> | undefined;
  /**
   * Target configuration passed to a target factory or specifier-loaded
   * target module. Opaque to this module — its shape belongs to the target
   * (Cloudflare: `{ worker?: CloudflareVitePluginOptions,
   * sessionKVBindingName?: string }`). Unused when {@link target} is already
   * a target *value*.
   */
  readonly targetConfig?: TargetConfig | undefined;
  /**
   * Extra Astro config merged into the in-memory `AstroInlineConfig`
   * (`site`, `base`, `integrations`, `devToolbar`, `vite`, ...). The
   * project's own `astro.config.*` file loads natively; this inline config
   * is merged OVER it by astro (arrays like `integrations`/`vite.plugins`
   * concatenate, scalars override). `root` is pinned; `output` is only set
   * when passed here (so a config file's `output` — or astro's `"static"`
   * default — is honored). Do not pass `adapter` — the deploy target
   * provides it, and a user-declared adapter fails the build with an
   * actionable error.
   */
  readonly astro?: AstroInlineConfig | undefined;
  /**
   * Path to an alternate Astro config file, resolved against {@link root}
   * when relative (astro itself resolves a relative `configFile` against
   * the process cwd, so this module anchors it to the project root before
   * handing it over). Defaults to astro's own config discovery
   * (`astro.config.*` in the project root).
   */
  readonly config?: string | undefined;
  /** Project root. Defaults to the process working directory. */
  readonly root?: string | undefined;
}

/** Inputs for {@link makeAstroInlineConfig} (exported for testing). */
export interface AstroConfigInputs {
  /** Absolute project root. */
  readonly root: string;
  /**
   * The deploy target's integration. Injected via `integrations` (after the
   * user's) rather than `adapter`: it registers itself as the adapter at
   * `astro:config:done`, where it also rejects a user-declared adapter with
   * an actionable error.
   */
  readonly integration: AstroIntegration;
  /** User Astro config merged in (its `vite.plugins` are preserved). */
  readonly userConfig?: AstroInlineConfig | undefined;
  /** Dev-server port (merged into `server.port`). */
  readonly port?: number | undefined;
  /** Dev-server host (merged into `server.host`). */
  readonly host?: string | undefined;
  /**
   * Extra Vite plugins appended after the user's (e.g. the build-output
   * collector).
   */
  readonly extraVitePlugins?: ReadonlyArray<ViteModule.Plugin> | undefined;
}

/**
 * Build the in-memory `AstroInlineConfig` — the overlay astro merges OVER
 * the project's own `astro.config.*` (which loads natively; `configFile`
 * is left undiscovered-default unless the user overlay carries one, so a
 * project without a config file falls back to a purely programmatic
 * config). Astro's `resolveConfig` merge
 * gives this inline config precedence: arrays (`integrations`,
 * `vite.plugins`) concatenate after the file's, scalars override.
 *
 * - The deploy target's integration is appended to `integrations` (it
 *   registers itself as the adapter at `astro:config:done` and fails the
 *   build if the user config already declares an `adapter`).
 * - `output` is NOT set unless the caller passes it explicitly: the inline
 *   config merges OVER the project's `astro.config.*`, so a default here
 *   would clobber the file's `output` (e.g. an explicit `"static"`). With
 *   neither source setting it, astro's own default (`"static"`, with
 *   per-route `prerender = false` opt-outs enabled by the adapter) applies.
 * - User `vite.plugins` are preserved ahead of the collector.
 */
export const makeAstroInlineConfig = (
  inputs: AstroConfigInputs,
): AstroInlineConfig => {
  const user = inputs.userConfig;
  const serverOverrides = {
    ...(inputs.port !== undefined ? { port: inputs.port } : {}),
    ...(inputs.host !== undefined ? { host: inputs.host } : {}),
  };
  const server: AstroInlineConfig["server"] =
    Object.keys(serverOverrides).length === 0
      ? user?.server
      : typeof user?.server === "function"
        ? (options) => ({
            ...(user.server as (options: unknown) => object)(options),
            ...serverOverrides,
          })
        : { ...user?.server, ...serverOverrides };
  return {
    logLevel: "warn",
    ...user,
    root: inputs.root,
    integrations: [...(user?.integrations ?? []), inputs.integration],
    server,
    vite: {
      ...user?.vite,
      plugins: [
        ...(user?.vite?.plugins ?? []),
        ...(inputs.extraVitePlugins ?? []),
      ],
    },
  };
};

/**
 * The Astro implementation of framework-core's `Framework` service.
 *
 * - `build` resolves the deploy target, then either delegates wholesale to
 *   `target.build` (when the target defines one) or runs astro's programmatic
 *   `build(AstroInlineConfig)` with the target's adapter integration and the
 *   shared build-output collector on the `ssr` environment (skipping astro's
 *   node-side `astro`/`prerender` environments), finishing with
 *   `applyDeployTargetFinish`. `serverModules[0]` is the ssr entry chunk
 *   (`server/entry.mjs`); `clientDirectory` is `dist/client`, captured as a
 *   path so prerendered HTML written after the Vite build rides along.
 * - `dev` runs astro's `dev()` with the target's adapter integration; with
 *   the Cloudflare target the `ssr` environment executes inside workerd via
 *   the cloudflare-vite-plugin module runner, with in-memory bindings — no
 *   wrangler config anywhere. Closing the Scope stops the server.
 *
 * Returns the service implementation as an Effect (the alchemy-side
 * `FrameworkModule` contract); use {@link layer} for the `Layer` form the
 * e2e harness consumes.
 */
export const make = <TargetConfig = unknown>(
  options?: AstroFrameworkOptions<TargetConfig>,
): Effect.Effect<
  FrameworkCore.Framework["Service"],
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const fail = (message: string) => (cause: unknown) =>
      new FrameworkCore.FrameworkError({
        framework: "astro",
        message,
        cause,
      });

    const failTarget = (error: FrameworkCore.DeployTargetError) =>
      new FrameworkCore.FrameworkError({
        framework: "astro",
        message: error.message,
        cause: error.cause ?? error,
      });

    // Astro's dev()/build() record telemetry events by default.
    yield* Effect.sync(() => {
      process.env.ASTRO_TELEMETRY_DISABLED ??= "1";
    });

    const resolveRoot = (override: string | undefined) =>
      Effect.sync(() =>
        path.resolve(override ?? options?.root ?? process.cwd()),
      );

    /**
     * The user's inline Astro overlay with `config` resolved into
     * `configFile`, anchored to the project root (astro resolves a
     * relative `configFile` against the process cwd, not `root`).
     */
    const resolveUserAstro = (root: string): AstroInlineConfig | undefined =>
      options?.config === undefined
        ? options?.astro
        : { ...options?.astro, configFile: path.resolve(root, options.config) };

    const resolveTarget = (
      root: string,
    ): Effect.Effect<AstroTarget, FrameworkCore.FrameworkError> =>
      FrameworkCore.resolveDeployTarget<AstroTarget, TargetConfig | undefined>(
        root,
        (options?.target ??
          DEFAULT_TARGET_SPECIFIER) as FrameworkCore.DeployTargetInput<
          AstroTarget,
          TargetConfig | undefined
        >,
        options?.targetConfig,
      ).pipe(
        Effect.mapError(failTarget),
        Effect.flatMap((target) =>
          isAstroTarget(target)
            ? Effect.succeed(target)
            : Effect.fail(
                fail(
                  "The resolved deploy target is not an AstroTarget: it must provide an " +
                    "`integration: () => AstroIntegration` hook",
                )(undefined),
              ),
        ),
      );

    const loadAstro = (
      root: string,
    ): Effect.Effect<AstroModule, FrameworkCore.FrameworkError> =>
      FrameworkCore.loadProjectModule<AstroModule>(root, "astro").pipe(
        Effect.mapError(fail("Failed to load the project's astro")),
      );

    const makeConfig = (
      root: string,
      target: AstroTarget,
      overrides?: Pick<AstroConfigInputs, "port" | "host" | "extraVitePlugins">,
    ): AstroInlineConfig =>
      makeAstroInlineConfig({
        root,
        integration: target.integration(),
        userConfig: resolveUserAstro(root),
        ...overrides,
      });

    return FrameworkCore.Framework.of({
      build: Effect.fn(function* (buildOptions) {
        const root = yield* resolveRoot(buildOptions?.root);
        const target = yield* resolveTarget(root);
        if (target.build !== undefined) {
          // Wholesale build takeover: the target owns the entire
          // production build (the OpenNext-style case). The inline Astro
          // overlay rides along (with `config` already resolved into an
          // absolute `configFile`) so a child-process build can
          // reconstruct the framework with the same options.
          return yield* target
            .build({
              root,
              framework: "astro",
              env: buildOptions?.env,
              astro: resolveUserAstro(root),
            })
            .pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.mapError(failTarget),
            );
        }
        const astro = yield* loadAstro(root);
        const collector = yield* FrameworkCore.makeBuildOutputCollector({
          entryEnvironment: "ssr",
          skipEnvironments: NODE_ENVIRONMENTS,
          selectEntry: target.selectServerEntry,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        const config = makeConfig(root, target, {
          extraVitePlugins: [collector.plugin],
        });
        yield* Effect.tryPromise({
          try: async () => await astro.build(config),
          catch: fail("Failed to build"),
        });
        // Disk re-read: astro injects the serialized SSR manifest into the
        // entry chunk on disk *after* the bundler finishes (the in-memory
        // capture still contains the `@@ASTRO_MANIFEST_REPLACE@@`
        // placeholder), and prunes the prerender-only chunks.
        const output = yield* collector
          .collect({ fromDisk: true })
          .pipe(Effect.mapError((error) => fail(error.message)(error.cause)));
        // The astro build is delivered in-memory (no on-disk entry handed
        // over), so the finish context carries no `entry`.
        return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
          root,
          framework: "astro",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(failTarget),
        );
      }),
      dev: Effect.fn(function* (devOptions) {
        const root = yield* resolveRoot(devOptions?.root);
        const target = yield* resolveTarget(root);
        const astro = yield* loadAstro(root);
        // `port: 0` (true OS-assigned) when the Vite under Astro is
        // >= 8.2.1, probed ephemeral port otherwise — see
        // `resolveViteDevPort`. Astro's dev server runs on Astro's own
        // Vite dependency, so the version is resolved from the astro
        // package's directory, not the project root.
        const viteVersion = yield* FrameworkCore.resolveProjectPackageDirectory(
          root,
          "astro",
        ).pipe(
          Effect.flatMap((astroDirectory) =>
            FrameworkCore.resolveInstalledPackageVersion(
              astroDirectory,
              "vite",
            ),
          ),
          Effect.orElseSucceed(() => undefined),
        );
        const port = yield* FrameworkCore.resolveViteDevPort(
          viteVersion,
          devOptions?.port,
        );
        const config = makeConfig(root, target, {
          port,
          host: devOptions?.host,
        });
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => await astro.dev(config),
            catch: fail("Failed to start the astro dev server"),
          }),
          (server) => Effect.promise(async () => await server.stop()),
        );
        const url =
          server.resolvedUrls?.local[0] ??
          (typeof server.address.port === "number"
            ? `http://localhost:${server.address.port}/`
            : undefined);
        if (url === undefined) {
          return yield* Effect.fail(
            fail("Could not determine the URL of the astro dev server")(
              undefined,
            ),
          );
        }
        return { url };
      }),
    });
  });

/**
 * The `Layer` form of {@link make} — the shape the e2e harness's framework
 * factory contract expects (`(options) => Layer<Framework>`).
 */
export const layer = <TargetConfig = unknown>(
  options?: AstroFrameworkOptions<TargetConfig>,
): Layer.Layer<
  FrameworkCore.Framework,
  never,
  FileSystem.FileSystem | Path.Path
> => Layer.effect(FrameworkCore.Framework, make(options));
