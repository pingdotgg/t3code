// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Wrangler-free fork of `@astrojs/cloudflare`'s `createIntegration`
 * (v14.1.3, `src/index.ts`) with:
 *
 * - `@cloudflare/vite-plugin` swapped for `@alchemy.run/cloudflare-runtime/vite`
 *   (main = this package's vendored server entrypoint, entry env `ssr`,
 *   Astro's node-side `astro`/`prerender` environments in `skipEnvironments`).
 * - `loadWranglerEnv`, wrangler config watchers, `previewEntrypoint`, and the
 *   output-wrangler.json patch dropped.
 *   (The `astro:build:done` wrangler.json assets-directory patch is replaced
 *   by the cloudflare target's `finish` pass over `BuildOutput` — see
 *   `cloudflare.ts` — and the vestigial parse of a pre-existing `_redirects`
 *   file, whose result upstream never uses, is dropped.)
 * - `prerenderEnvironment: 'workerd'` by default like upstream, but the
 *   prerenderer serves the built `prerender` environment through
 *   `cloudflare-runtime` instead of a Vite preview server wrapped around
 *   `@cloudflare/vite-plugin` (see `prerenderer.ts`); `'node'` falls back to
 *   Astro's stock node prerenderer.
 * - Zero-config sessions mirrored from upstream: when `config.session.driver`
 *   is unset, the `cloudflareKVBinding` driver is configured against the
 *   `sessionKVBindingName` KV binding; in dev, a local in-memory KV namespace
 *   (`KvNamespace.local`) is injected into the worker bindings. Opt out with
 *   `sessions: false`.
 * - The image service is `passthrough` (workerd cannot run sharp, and the
 *   IMAGES binding is remote-only in our runtime).
 */
import { removeTrailingForwardSlash } from "@astrojs/internal-helpers/path";
import {
  createRedirectsFromAstroRoutes,
  printAsRedirects,
} from "@astrojs/underscore-redirects";
import type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";
import cloudflareVitePlugin from "@alchemy.run/cloudflare-runtime/vite";
import { KvNamespace } from "@alchemy.run/cloudflare-runtime/core/bindings";
import type {
  AstroConfig,
  AstroIntegration,
  IntegrationResolvedRoute,
} from "astro";
import { passthroughImageService, sessionDrivers } from "astro/config";
import {
  appendFile,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type * as vite from "vite";
import { createConfigPlugin } from "./config-plugin.ts";
import { NODE_ENVIRONMENTS } from "./environments.ts";
import { buildAssetsHeadersContent } from "./headers.ts";
import { createWorkerdPrerenderEnvironmentPlugin } from "./prerender-environment.ts";
import { createNodePrerenderPlugin } from "./prerender-middleware.ts";

/** The Worker entry module (the vendored `@astrojs/cloudflare` server entrypoint). */
export const SERVER_ENTRYPOINT =
  "@alchemy.run/frontend-frameworks/astro/entrypoints/server";

/** The production endpoint of the passthrough image service. */
export const IMAGE_PASSTHROUGH_ENDPOINT = fileURLToPath(
  import.meta
    .resolve("@alchemy.run/frontend-frameworks/astro/image-passthrough-endpoint"),
);

export interface DistilledCloudflareOptions {
  /**
   * Options forwarded to `@alchemy.run/cloudflare-runtime/vite`
   * (compatibility date/flags, worker name/bindings/assets, runtime context).
   * `main`, `viteEnvironments`, and the Astro node environments in
   * `skipEnvironments` are managed by the integration.
   */
  readonly vite?: CloudflareVitePluginOptions | undefined;
  /**
   * Which runtime prerenders static pages at build time.
   *
   * - `'workerd'` (default, matching upstream): the `prerender` environment
   *   is built as a Worker (same treatment as the `ssr` environment) and
   *   served from workerd via `cloudflare-runtime`, so prerendered pages run
   *   in the production runtime — top-level `cloudflare:*` imports and the
   *   configured worker bindings included.
   * - `'node'`: Astro's stock node prerender environment. Fallback for pages
   *   that depend on Node-only APIs at build time.
   * @default "workerd"
   */
  readonly prerenderEnvironment?: "workerd" | "node" | undefined;
  /**
   * The name of the KV binding injected into Astro's session config when
   * present on the Worker env.
   * @default "SESSION"
   */
  readonly sessionKVBindingName?: string | undefined;
  /**
   * Zero-config sessions (mirrors upstream `@astrojs/cloudflare`): when no
   * `session.driver` is configured, Astro's `cloudflareKVBinding` session
   * driver is configured against the {@link sessionKVBindingName} KV
   * binding. Set to `false` to leave the session config untouched (sessions
   * stay off unless you configure a driver yourself).
   * @default true
   */
  readonly sessions?: boolean | undefined;
  /**
   * Automatically add an in-memory local KV namespace
   * (`KvNamespace.local({ binding: sessionKVBindingName })`) so zero-config
   * sessions work without any setup: in dev it is appended to the dev worker
   * bindings; at build time (workerd prerendering) it is appended to the
   * prerender environment worker's bindings so session-touching pages can
   * prerender (the deployed Worker still uses its real KV binding — the
   * prerender KV is ephemeral, matching upstream's local preview bindings).
   * Disable when the bindings already carry a KV binding with that name
   * (binding names must be unique) — e.g. when an outer toolchain provisions
   * the session namespace itself and passes it through
   * `vite.worker.bindings`.
   * @default true
   */
  readonly sessionDevKV?: boolean | undefined;
  /**
   * Reports the absolute path of the *original* client build directory
   * (`config.build.client` before the `base !== "/"` remap nests it). The
   * cloudflare target's `finish` pass uses it to point
   * `BuildOutput.clientDirectory` back at the directory that should be
   * served at the URL root.
   * @internal
   */
  readonly onOriginalClientDir?: ((dir: string) => void) | undefined;
  /**
   * Reports the resolved build output mode (`astro:config:done`'s
   * `buildOutput`): `"static"` when every route is prerendered, `"server"`
   * when any route renders on demand. The cloudflare target's `finish` pass
   * uses it to strip `serverModules` from a fully-static build so the deploy
   * is assets-only (no worker).
   * @internal
   */
  readonly onBuildOutput?:
    | ((buildOutput: "static" | "server") => void)
    | undefined;
}

/**
 * Upstream `@astrojs/cloudflare` adapter options this fork deliberately does
 * not support, with the reason / migration. Passing one raises immediately
 * instead of being silently ignored.
 */
const UNSUPPORTED_UPSTREAM_OPTIONS: Record<string, string> = {
  imageService:
    "the image service is hardwired to `passthrough` (workerd cannot run sharp, and the IMAGES binding is remote-only in our runtime)",
  imagesBindingName:
    "the Cloudflare Images binding image service is not supported (the IMAGES binding is remote-only in our runtime)",
  platformProxy:
    "there is no wrangler platform proxy; dev bindings are passed via `vite.worker.bindings`",
  configPath:
    "there is no wrangler config file; pass worker options via `vite`",
  persistState: "workerd state is in-memory in this fork's dev runtime",
  auxiliaryWorkers:
    "auxiliary workers are not supported; compose bindings via `vite.worker.bindings`",
  inspectorPort:
    "the workerd inspector is not exposed by this fork's dev runtime",
  viteEnvironment:
    "the worker environment is pinned to Astro's `ssr` environment",
  cloudflareModules:
    "`.wasm`/`.bin`/`.txt` worker modules are handled by `@alchemy.run/cloudflare-runtime/vite`",
  experimental: "upstream experimental options are not supported by this fork",
};

/** Reject upstream adapter options we would otherwise silently ignore. */
const assertSupportedOptions = (options: DistilledCloudflareOptions): void => {
  const offending = Object.keys(options).filter(
    (key) => key in UNSUPPORTED_UPSTREAM_OPTIONS,
  );
  if (offending.length > 0) {
    throw new Error(
      "@alchemy.run/frontend-frameworks/astro: unsupported @astrojs/cloudflare option(s):\n" +
        offending
          .map((key) => `  - \`${key}\`: ${UNSUPPORTED_UPSTREAM_OPTIONS[key]}`)
          .join("\n") +
        "\nSupported options: `vite`, `prerenderEnvironment`, `sessionKVBindingName`, `sessions`, `sessionDevKV`.",
    );
  }
};

/**
 * Whether the (possibly zero-config-defaulted) session config uses Astro's
 * `cloudflareKVBinding` driver — vendored from upstream
 * (`usesCloudflareKVSessionDriver`).
 */
const CLOUDFLARE_KV_SESSION_DRIVER_ENTRYPOINT =
  sessionDrivers.cloudflareKVBinding().entrypoint;

type SessionConfigLike =
  | {
      driver?:
        | string
        | { entrypoint: string | { toString(): string } }
        | undefined;
      cookie?: unknown;
      ttl?: unknown;
    }
  | undefined;

export const usesCloudflareKVSessionDriver = (
  session: SessionConfigLike,
): boolean => {
  const driver = session?.driver;
  if (!driver) {
    return false;
  }
  if (typeof driver === "string") {
    return (
      driver === "cloudflareKVBinding" || driver === "cloudflare-kv-binding"
    );
  }
  const entrypoint =
    typeof driver.entrypoint === "string"
      ? driver.entrypoint
      : driver.entrypoint.toString();
  return (
    entrypoint === CLOUDFLARE_KV_SESSION_DRIVER_ENTRYPOINT ||
    entrypoint.endsWith("cloudflare-kv-binding")
  );
};

/**
 * Append the in-memory local session KV namespace to the dev worker
 * bindings (exported for testing). Binding names must be unique per worker:
 * if the dev bindings already carry a `sessionKVBindingName` KV binding,
 * disable this injection with `sessionDevKV: false` (or rename via
 * `sessionKVBindingName`).
 */
export const withDevSessionKv = (
  viteOptions: CloudflareVitePluginOptions | undefined,
  binding: string,
): CloudflareVitePluginOptions => ({
  ...viteOptions,
  // A bindings-only worker is fine: the dev server generates a worker name
  // when none is configured.
  worker: {
    ...viteOptions?.worker,
    bindings: [
      ...(viteOptions?.worker?.bindings ?? []),
      KvNamespace.local({ binding }),
    ],
  } as CloudflareVitePluginOptions["worker"],
});

/**
 * The workerd prerenderer's vite-plugin options (exported for testing): when
 * zero-config sessions resolved to the Cloudflare KV driver, the same
 * in-memory local KV namespace that dev injects is appended to the prerender
 * worker's bindings — session-touching pages can then prerender without the
 * deployed Worker's real KV namespace existing at build time (upstream's
 * prerender worker receives the local preview bindings the same way). The
 * KV is ephemeral: session state written during prerendering is discarded
 * with the prerender worker. `sessionDevKV: false` opts out (e.g. when the
 * caller's own `vite.worker.bindings` already carry the session binding).
 */
export const withPrerenderSessionKv = (
  viteOptions: CloudflareVitePluginOptions | undefined,
  options: {
    readonly needsSessionKVBinding: boolean;
    readonly sessionDevKV: boolean;
    readonly binding: string;
  },
): CloudflareVitePluginOptions | undefined =>
  options.needsSessionKVBinding && options.sessionDevKV
    ? withDevSessionKv(viteOptions, options.binding)
    : viteOptions;

/**
 * The `@alchemy.run/cloudflare-runtime/vite` options for an Astro project:
 * user options with `main` pinned to the vendored server entrypoint, the
 * worker pinned to Astro's `ssr` environment, and Astro's node-side
 * environments merged into `skipEnvironments` (exported for testing).
 *
 * During a `build` with `prerenderEnvironment: "workerd"`, the `prerender`
 * environment stops being a skipped node environment and becomes a child
 * worker environment instead: it gets the full worker treatment (workerd
 * resolve conditions, unenv polyfills, `cloudflare:` externals) so its
 * output can be loaded into workerd by the prerenderer. In dev, `prerender`
 * stays skipped in both modes — workerd mode has no prerender dev
 * environment at all (prerenderable routes are served through the entry
 * worker's dev-match path).
 */
export const makeIntegrationPluginOptions = (
  viteOptions: CloudflareVitePluginOptions = {},
  {
    prerenderEnvironment = "node",
    command = "dev",
  }: {
    prerenderEnvironment?: "workerd" | "node";
    command?: "dev" | "build" | "preview" | "sync";
  } = {},
): CloudflareVitePluginOptions => {
  const workerdPrerender =
    prerenderEnvironment === "workerd" && command === "build";
  return {
    ...viteOptions,
    main: SERVER_ENTRYPOINT,
    viteEnvironments: workerdPrerender
      ? { entry: "ssr", children: ["prerender"] }
      : { entry: "ssr" },
    skipEnvironments: [
      ...new Set(
        [...NODE_ENVIRONMENTS, ...(viteOptions.skipEnvironments ?? [])].filter(
          (name) => !(workerdPrerender && name === "prerender"),
        ),
      ),
    ],
  };
};

export function distilledCloudflare(
  options: DistilledCloudflareOptions = {},
): AstroIntegration {
  assertSupportedOptions(options);
  const prerenderEnvironment = options.prerenderEnvironment ?? "workerd";
  const sessionKVBindingName = options.sessionKVBindingName ?? "SESSION";
  const sessions = options.sessions ?? true;
  const sessionDevKV = options.sessionDevKV ?? true;
  let _config: AstroConfig;
  let _buildOutput: "static" | "server";
  let _originalClientDir: URL;
  let _routes: Array<IntegrationResolvedRoute> = [];
  // Whether the (possibly zero-config-defaulted) session config resolved to
  // the Cloudflare KV driver — set at `astro:config:setup`, read at
  // `astro:build:start` to give the workerd prerender worker a local
  // session KV.
  let _needsSessionKVBinding = false;
  // Whether WE satisfied `config.adapter`. The user's astro.config.* loads
  // natively and this integration is injected via `integrations`, but
  // astro's build refuses server output unless `config.adapter` is set — so
  // `astro:config:setup` injects a hookless marker when the config declares
  // no adapter (the real adapter registration is `setAdapter` at
  // `astro:config:done`). When the flag is still false at
  // `astro:config:done`, the user declared their own adapter — a conflict.
  let _injectedAdapterMarker = false;
  return {
    name: "@alchemy.run/frontend-frameworks/astro",
    hooks: {
      "astro:config:setup": ({ command, config, updateConfig, logger }) => {
        const isTypeGenPhase = command === "build" || command === "sync";
        const userOptimizeDeps = config.vite?.optimizeDeps;

        // Zero-config sessions (mirrors upstream): default the session
        // driver to Cloudflare KV against `sessionKVBindingName` when the
        // user hasn't configured one.
        // `session: false` is the user explicitly disabling sessions —
        // respect it and skip the zero-config defaulting.
        let session = config.session;
        if (sessions && session !== false && !session?.driver) {
          logger.info(
            `Enabling sessions with Cloudflare KV with the "${sessionKVBindingName}" KV binding.`,
          );
          session = {
            driver: sessionDrivers.cloudflareKVBinding({
              binding: sessionKVBindingName,
            }),
            cookie: session?.cookie,
            ttl: session?.ttl,
          } as typeof config.session;
        }
        const needsSessionKVBinding =
          sessions &&
          session !== false &&
          usesCloudflareKVSessionDriver(session);
        _needsSessionKVBinding = needsSessionKVBinding;

        // In dev, satisfy the session KV binding with an in-memory local KV
        // namespace so zero-config sessions work without any setup.
        const viteOptions =
          command === "dev" && needsSessionKVBinding && sessionDevKV
            ? withDevSessionKv(options.vite, sessionKVBindingName)
            : options.vite;

        const cloudflarePlugins = cloudflareVitePlugin(
          makeIntegrationPluginOptions(viteOptions, {
            prerenderEnvironment,
            command,
          }),
        ) as Array<vite.Plugin>;

        // Same trick as upstream (astro#16332): `build`/`sync` run type
        // generation, which creates a temporary Vite server and fires
        // `configureServer` — that would boot workerd mid-build. Stripping
        // the hook degrades our dev environments to runnable stubs, a
        // supported contract of the dev plugin.
        if (isTypeGenPhase) {
          for (const plugin of cloudflarePlugins) {
            plugin.configureServer = undefined;
          }
        }

        if (config.adapter === undefined) {
          // Satisfy astro's `config.adapter` existence check (the build
          // refuses server output without it). Hookless on purpose: the
          // marker is inert even if a later `runHookConfigSetup` pass
          // unshifts it into `integrations`; the real adapter is registered
          // via `setAdapter` at `astro:config:done`.
          _injectedAdapterMarker = true;
          updateConfig({
            adapter: {
              name: "@alchemy.run/frontend-frameworks/astro",
              hooks: {},
            },
          });
        }

        updateConfig({
          build: { redirects: false },
          session,
          vite: {
            plugins: [
              // Node mode only: in workerd mode dev has no prerender
              // environment — prerenderable routes are served through the
              // entry worker's dev-match path, same as upstream.
              ...(command === "dev" && prerenderEnvironment === "node"
                ? [createNodePrerenderPlugin()]
                : []),
              ...(prerenderEnvironment === "workerd"
                ? [createWorkerdPrerenderEnvironmentPlugin(SERVER_ENTRYPOINT)]
                : []),
              cloudflarePlugins,
              {
                name: "@alchemy.run/frontend-frameworks/astro:cf-imports",
                enforce: "pre",
                resolveId: {
                  filter: { id: /^cloudflare:/ },
                  handler(id) {
                    return { id, external: true };
                  },
                },
              } satisfies vite.Plugin,
              {
                name: "@alchemy.run/frontend-frameworks/astro:environment",
                configEnvironment(environmentName, environmentOptions) {
                  if (isTypeGenPhase) {
                    return { optimizeDeps: { noDiscovery: true, include: [] } };
                  }
                  const isServerEnvironment = [
                    "astro",
                    "ssr",
                    "prerender",
                  ].includes(environmentName);
                  if (
                    isServerEnvironment &&
                    !environmentOptions.optimizeDeps?.noDiscovery
                  ) {
                    return {
                      optimizeDeps: {
                        include: [
                          SERVER_ENTRYPOINT,
                          "astro",
                          "astro/runtime/**",
                          "astro > html-escaper",
                          "astro > mrmime",
                          "astro > zod/v4",
                          "astro > zod/v4/core",
                          "astro > clsx",
                          "astro > cookie",
                          "astro > devalue",
                          "astro > @oslojs/encoding",
                          "astro > es-module-lexer",
                          "astro > unstorage",
                          "astro > neotraverse/modern",
                          "astro > piccolore",
                          "astro > picomatch",
                          "astro/app",
                          "astro/app/fetch/default-handler",
                          "astro/fetch",
                          "astro/assets",
                          "astro/assets/runtime",
                          "astro/assets/utils/inferRemoteSize.js",
                          "astro/assets/fonts/runtime.js",
                          "astro/compiler-runtime",
                          "astro/jsx-runtime",
                          "astro/app/entrypoint/dev",
                          "astro/virtual-modules/middleware.js",
                          "astro/virtual-modules/transitions.js",
                          "astro/virtual-modules/transitions-events.js",
                          "astro/virtual-modules/transitions-router.js",
                          "astro/virtual-modules/transitions-swap-functions.js",
                          "astro/virtual-modules/transitions-types.js",
                          "astro/components",
                          ...(Array.isArray(userOptimizeDeps?.include)
                            ? userOptimizeDeps.include
                            : []),
                        ],
                        exclude: [
                          "unstorage/drivers/cloudflare-kv-binding",
                          "astro:*",
                          "virtual:astro:*",
                          "virtual:astro-cloudflare:*",
                          "virtual:@astrojs/*",
                          "@astrojs/starlight",
                          ...(Array.isArray(userOptimizeDeps?.exclude)
                            ? userOptimizeDeps.exclude
                            : []),
                        ],
                      },
                    };
                  } else if (environmentName === "client") {
                    return {
                      optimizeDeps: {
                        include: [
                          "astro/runtime/client/dev-toolbar/entrypoint.js",
                        ],
                        ignoreOutdatedRequests: true,
                      },
                    };
                  }
                  return undefined;
                },
              } satisfies vite.Plugin,
              {
                enforce: "post",
                name: "@alchemy.run/frontend-frameworks/astro:cf-externals",
                applyToEnvironment: (environment) =>
                  environment.name === "ssr" ||
                  environment.name === "prerender",
                config(conf) {
                  if (conf.ssr) {
                    // Cloudflare does not support externalizing modules in server environments
                    conf.ssr.external = undefined;
                  }
                },
              } satisfies vite.Plugin,
              createConfigPlugin({
                sessionKVBindingName,
                compileImageConfig: null,
                cacheProviderEnabled: false,
              }),
            ],
          },
          image: {
            ...config.image,
            service: passthroughImageService(),
            endpoint: (command === "dev"
              ? { entrypoint: "astro/assets/endpoint/generic" }
              : { entrypoint: IMAGE_PASSTHROUGH_ENDPOINT }) as never,
          },
        });
      },
      "astro:routes:resolved": ({ routes }) => {
        _routes = routes;
      },
      "astro:config:done": ({
        setAdapter,
        config,
        injectTypes,
        buildOutput,
      }) => {
        // The user's astro.config.* loads natively and this integration is
        // merged over it, so a user-declared adapter (e.g. upstream
        // @astrojs/cloudflare) would collide with the one the deploy target
        // provides. Fail with an actionable error instead of letting the two
        // adapters race.
        if (config.adapter !== undefined && !_injectedAdapterMarker) {
          throw new Error(
            `@alchemy.run/frontend-frameworks/astro: the Astro config declares the adapter "${config.adapter.name}", ` +
              "but the deploy target already provides the Cloudflare adapter. " +
              "Remove `adapter` from your astro.config file — user integrations " +
              "(react, mdx, tailwind, ...) are honored, and the adapter is injected by the toolchain.",
          );
        }
        _config = config;
        _buildOutput = buildOutput;
        options.onBuildOutput?.(buildOutput);
        _originalClientDir = new URL(config.build.client.href);
        if (config.base !== "/") {
          // Nest the client build under the base so the assets directory can
          // be served at the URL root (`/base/foo.css` →
          // `dist/client/base/foo.css`). `astro:build:done` moves the special
          // files back up, and the cloudflare target's `finish` pass points
          // `BuildOutput.clientDirectory` back at the original directory.
          config.build.client = new URL(
            "." + config.base + "/",
            config.build.client,
          );
        }
        options.onOriginalClientDir?.(fileURLToPath(_originalClientDir));
        injectTypes({
          filename: "cloudflare.d.ts",
          content:
            '/// <reference types="@alchemy.run/frontend-frameworks/astro/types.d.ts" />',
        });
        setAdapter({
          name: "@alchemy.run/frontend-frameworks/astro",
          adapterFeatures: {
            buildOutput,
            middlewareMode: "classic",
            preserveBuildClientDir: true,
            preserveBuildServerDir: true,
          },
          entrypointResolution: "auto",
          supportedAstroFeatures: {
            serverOutput: "stable",
            hybridOutput: "stable",
            staticOutput: "stable",
            i18nDomains: "experimental",
            sharpImageService: {
              support: "limited",
              message: "workerd cannot run sharp",
            },
            envGetSecret: "stable",
          },
        });
      },
      "astro:build:start": async ({ setPrerenderer }) => {
        if (prerenderEnvironment !== "workerd") {
          return;
        }
        // Lazy: the prerenderer pulls Effect + cloudflare-runtime, which
        // `astro dev` and node-mode builds never need.
        const { createWorkerdPrerenderer } = await import("./prerenderer.ts");
        setPrerenderer(
          createWorkerdPrerenderer({
            serverDir: _config.build.server,
            // With `base !== "/"` the client build is nested under the base
            // (`astro:config:done` above); assets are served from the
            // original client root, so that is the prerender worker's assets
            // directory too.
            clientDir: _originalClientDir,
            trailingSlash: _config.trailingSlash,
            // Zero-config sessions: the prerender worker gets an ephemeral
            // in-memory SESSION KV (the deployed Worker's real namespace
            // need not exist at build time). See `withPrerenderSessionKv`.
            vite: withPrerenderSessionKv(options.vite, {
              needsSessionKVBinding: _needsSessionKVBinding,
              sessionDevKV,
              binding: sessionKVBindingName,
            }),
          }),
        );
      },
      "astro:build:setup": ({ vite: viteConfig, target }) => {
        if (target === "server") {
          viteConfig.resolve ||= {};
          viteConfig.resolve.alias ||= {};
          viteConfig.ssr ||= {};
          viteConfig.ssr.noExternal = true;

          viteConfig.build ||= {};
          const build = viteConfig.build as Record<string, any>;
          build.rolldownOptions ||= {};
          build.rolldownOptions.output ||= {};
          build.rolldownOptions.external = ["sharp"];
          build.rolldownOptions.output.banner ||=
            "globalThis.process ??= {}; globalThis.process.env ??= {};";

          viteConfig.define = {
            "process.env": "process.env",
            "globalThis.__ASTRO_IMAGES_BINDING_NAME": JSON.stringify("IMAGES"),
            ...viteConfig.define,
          };
        }
      },
      "astro:build:done": async ({ dir, logger, assets }) => {
        // base !== "/": the client build was nested under the base
        // (`astro:config:done` above); the asset-server special files must
        // live at the served directory's root, so move them back up.
        if (_config.base !== "/") {
          for (const file of [".assetsignore", "_headers", "_redirects"]) {
            try {
              await rename(
                new URL(`./${file}`, _config.build.client),
                new URL(`./${file}`, _originalClientDir),
              );
            } catch {
              // The file was not emitted for this build.
            }
          }
          // Upstream also patches the emitted wrangler.json's
          // `assets.directory` here; this build has no wrangler.json — the
          // cloudflare target's `finish` pass rewrites
          // `BuildOutput.clientDirectory` instead (see `cloudflare.ts`).
        }

        // Immutable Cache-Control for the content-hashed assets directory.
        if (_config.build.assetsPrefix) {
          logger.debug(
            "Skipping Cache-Control injection for assets — `build.assetsPrefix` is set, so assets are served from a different origin.",
          );
        } else {
          const headersPath = new URL("./_headers", _originalClientDir);
          const result = await buildAssetsHeadersContent(
            {
              assetsDir: _config.build.assets,
              basePrefix: removeTrailingForwardSlash(_config.base),
              headersPath,
            },
            (path) => readFile(path, "utf-8"),
          );
          if (result === null) {
            logger.debug(
              "Skipping Cache-Control injection — _headers already sets Cache-Control on a matching rule.",
            );
          } else {
            const tempPath = new URL("./_headers.tmp", _originalClientDir);
            try {
              await writeFile(tempPath, result.content);
              await rename(tempPath, headersPath);
            } catch (err) {
              await unlink(tempPath).catch(() => {});
              throw err;
            }
            logger.info(
              `Injected immutable Cache-Control for ${result.assetsPattern} into _headers.`,
            );
          }
        }

        // Emit `_redirects` entries for Astro's redirect routes (config
        // `redirects` + `Astro.redirect` route files) so prerendered/static
        // redirects are handled by the asset server ahead of the Worker.
        const trueRedirects = createRedirectsFromAstroRoutes({
          config: _config,
          routeToDynamicTargetMap: new Map(
            Array.from(
              _routes
                .filter((route) => route.type === "redirect")
                .map((route) => [route, ""]),
            ),
          ),
          dir,
          buildOutput: _buildOutput,
          assets,
        });
        if (!trueRedirects.empty()) {
          try {
            await appendFile(
              new URL("./_redirects", _originalClientDir),
              printAsRedirects(trueRedirects),
            );
          } catch {
            logger.error("Failed to write _redirects file");
          }
        }
      },
    },
  };
}
