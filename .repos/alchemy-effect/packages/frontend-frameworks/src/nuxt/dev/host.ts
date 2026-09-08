/**
 * Cloudflare dev transport — HOST half.
 *
 * Runs in the alchemy / e2e-harness process: opens `cloudflare-runtime`'s
 * platform proxy (a local workerd instance hosting the configured binding
 * hooks behind the internal proxy worker) and produces the
 * {@link NuxtDevPlatform} the framework half injects into `loadNuxt`
 * overrides — the dev-only nitro plugin (`./plugin.ts`) plus the
 * `runtimeConfig` connect info. The proxy's entire client state is
 * `connectInfo: { url, token }` — two plain strings — which is what lets
 * the nitro dev SSR worker THREAD reconstruct the platform over HTTP
 * (`platform-proxy/connect`) with live-shared binding state.
 */
import { DeployTargetError } from "../../core/index.ts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import type { NuxtDevPlatform, NuxtDevPlatformContext } from "../Nuxt.ts";
import { RUNTIME_CONFIG_KEY, type DevConnectInfo } from "./shared.ts";

/**
 * The runtime-free client subpath of `cloudflare-runtime` the dev plugin is
 * built on. Resolved HOST-side (this package depends on
 * `cloudflare-runtime`) to an absolute path the dev worker imports
 * directly — the worker itself cannot resolve the bare specifier when
 * `cloudflare-runtime` is only a transitive dependency of the project.
 */
export const CLIENT_MODULE_SPECIFIER =
  "@alchemy.run/cloudflare-runtime/core/platform-proxy/connect";

/** Resolve the absolute path of the shipped dev-only nitro plugin. */
export const resolveDevPluginPath = (): string => {
  const packageJson = fileURLToPath(
    import.meta.resolve("@alchemy.run/frontend-frameworks/package.json"),
  );
  return NodePath.join(
    NodePath.dirname(packageJson),
    "dist",
    "nuxt",
    "dev",
    "plugin.js",
  );
};

/** Resolve {@link CLIENT_MODULE_SPECIFIER} to an absolute file path. */
export const resolveClientModulePath = (): string =>
  fileURLToPath(import.meta.resolve(CLIENT_MODULE_SPECIFIER));

/** What the dev platform needs back from an opened proxy. */
export interface DevProxyHandle {
  /** Base URL of the proxy workerd instance. */
  readonly url: string;
  /** The instance's auth token. */
  readonly token: string;
  /** Tear the proxy down. Safe to call multiple times. */
  readonly dispose: () => Promise<void>;
}

export interface OpenDevProxyOptions {
  readonly name: string;
  readonly compatibilityDate?: string | undefined;
  readonly compatibilityFlags?: ReadonlyArray<string> | undefined;
  /** `cloudflare-runtime` binding hooks (opaque through the framework half). */
  readonly bindings: ReadonlyArray<unknown>;
  /**
   * Pre-built `Context<RuntimeServices>` to host the proxy in (opaque
   * through the framework half). Enables remote()-lowered bindings, which
   * the proxy's internal local-only layer cannot serve.
   */
  readonly services?: unknown;
}

/** How the platform proxy is opened. A test seam; the default is {@link openPlatformProxy}. */
export type OpenDevProxy = (
  options: OpenDevProxyOptions,
) => Promise<DevProxyHandle>;

/**
 * The default opener: `cloudflare-runtime`'s `getPlatformProxy` (imported
 * lazily so production builds never load the runtime machinery). The
 * instance's `connectInfo` carries everything the dev plugin needs.
 */
export const openPlatformProxy: OpenDevProxy = async (options) => {
  const { getPlatformProxy } =
    await import("@alchemy.run/cloudflare-runtime/core/platform-proxy");
  const proxy = await getPlatformProxy({
    name: options.name,
    ...(options.compatibilityDate !== undefined
      ? { compatibilityDate: options.compatibilityDate }
      : undefined),
    ...(options.compatibilityFlags !== undefined
      ? { compatibilityFlags: [...options.compatibilityFlags] }
      : undefined),
    bindings: options.bindings as Parameters<
      typeof getPlatformProxy
    >[0]["bindings"],
    ...(options.services !== undefined
      ? {
          services: options.services as Parameters<
            typeof getPlatformProxy
          >[0]["services"],
        }
      : undefined),
  });
  return {
    url: proxy.connectInfo.url,
    token: proxy.connectInfo.token,
    dispose: proxy.dispose,
  };
};

export interface CloudflareDevPlatformOptions {
  /** Name of the proxy workerd service. @default "nuxt-dev-platform-proxy" */
  readonly name?: string | undefined;
  /** Compatibility date for the binding-proxy workerd instance. */
  readonly compatibilityDate?: string | undefined;
  /** Compatibility flags for the binding-proxy workerd instance. */
  readonly compatibilityFlags?: ReadonlyArray<string> | undefined;
  /** Override how the proxy is opened. A test seam. */
  readonly openProxy?: OpenDevProxy | undefined;
}

/**
 * Literal env values for the plugin: strings pass through; everything else
 * (resource bindings) is delivered through the proxy itself.
 */
const literalEnv = (
  env: Record<string, unknown> | undefined,
): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * The Cloudflare target's dev platform: open the proxy (scoped — closing
 * the Scope disposes the workerd instance) and hand the framework half the
 * nitro plugin + `runtimeConfig` connect info to inject.
 */
export const makeCloudflareDevPlatform =
  (options: CloudflareDevPlatformOptions = {}) =>
  (
    context: NuxtDevPlatformContext,
  ): Effect.Effect<NuxtDevPlatform, DeployTargetError, Scope.Scope> =>
    Effect.gen(function* () {
      const open = options.openProxy ?? openPlatformProxy;
      const proxy = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            open({
              name: options.name ?? "nuxt-dev-platform-proxy",
              compatibilityDate: options.compatibilityDate,
              compatibilityFlags: options.compatibilityFlags,
              bindings: context.bindings ?? [],
              services: context.services,
            }),
          catch: (cause) =>
            new DeployTargetError({
              platform: "cloudflare",
              message: "Failed to open the dev platform proxy",
              cause,
            }),
        }),
        (handle) => Effect.promise(() => handle.dispose().catch(() => {})),
      );
      const clientModule = yield* Effect.try({
        try: resolveClientModulePath,
        catch: (cause) =>
          new DeployTargetError({
            platform: "cloudflare",
            message:
              `Failed to resolve "${CLIENT_MODULE_SPECIFIER}" — the Nuxt dev bridge ` +
              "requires @alchemy.run/cloudflare-runtime/core (a dependency of this package)",
            cause,
          }),
      });
      const env = literalEnv(context.env);
      const connectInfo: DevConnectInfo = {
        url: proxy.url,
        token: proxy.token,
        clientModule,
        ...(env !== undefined ? { env } : {}),
      };
      return {
        nitroPlugins: [resolveDevPluginPath()],
        runtimeConfig: { [RUNTIME_CONFIG_KEY]: connectInfo },
      } satisfies NuxtDevPlatform;
    });
