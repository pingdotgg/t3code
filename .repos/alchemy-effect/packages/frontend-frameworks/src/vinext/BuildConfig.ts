import * as Effect from "effect/Effect";
import type { PluginOption } from "vite";
import { loadVinextModule } from "./Modules.ts";

interface NextConfigModule {
  PHASE_PRODUCTION_BUILD: string;
  findVinextNextConfigInPlugins(
    plugins: PluginOption[] | undefined,
  ): Promise<unknown>;
  resolveNextConfigInput(config: unknown, phase: string): Promise<unknown>;
  loadNextConfig(root: string, phase: string): Promise<unknown>;
  resolveNextConfig(
    config: unknown,
    root: string,
  ): Promise<{
    buildId: string;
    output?: "standalone" | "export";
  }>;
  createRscCompatibilityId(config: unknown): string;
}

interface PrerenderConfigModule {
  findVinextPrerenderConfigInPlugins(
    plugins: PluginOption[] | undefined,
  ): Promise<unknown>;
  findVinextRouteRootConfigInPlugins(
    plugins: PluginOption[] | undefined,
  ): Promise<unknown>;
  findVinextCacheConfigInPlugins(
    plugins: PluginOption[] | undefined,
  ): Promise<unknown>;
  hasBuildIdentityResponseHeader(cache: unknown): boolean;
  hasVerbatimResponseVary(cache: unknown): boolean;
  hasUncachedRequestRouting(cache: unknown): boolean;
  isConfiguredCdnResponsePolicyHeader(cache: unknown, name: string): boolean;
}

/** Keep native configuration objects intact when forwarding them between build phases. */
export const loadVinextBuildConfig = Effect.fn(function* (
  root: string,
  plugins: PluginOption[] | undefined,
) {
  const next = yield* loadVinextModule<NextConfigModule>(
    root,
    "config/next-config.js",
  );
  const prerender = yield* loadVinextModule<PrerenderConfigModule>(
    root,
    "config/prerender.js",
  );
  return yield* Effect.tryPromise(async () => {
    const input = await next.findVinextNextConfigInPlugins(plugins);
    const raw = input
      ? await next.resolveNextConfigInput(input, next.PHASE_PRODUCTION_BUILD)
      : await next.loadNextConfig(root, next.PHASE_PRODUCTION_BUILD);
    const nextConfig = await next.resolveNextConfig(raw, root);
    const cache = await prerender.findVinextCacheConfigInPlugins(plugins);
    return {
      nextConfig,
      rscCompatibilityId: next.createRscCompatibilityId(nextConfig),
      prerenderConfig:
        await prerender.findVinextPrerenderConfigInPlugins(plugins),
      routeRootConfig:
        await prerender.findVinextRouteRootConfigInPlugins(plugins),
      buildIdentity: prerender.hasBuildIdentityResponseHeader(cache)
        ? "response-header"
        : undefined,
      responseVary: prerender.hasVerbatimResponseVary(cache)
        ? "verbatim"
        : undefined,
      requestRouting: prerender.hasUncachedRequestRouting(cache)
        ? "uncached-stage"
        : undefined,
      isResponsePolicyHeader: (name: string) =>
        prerender.isConfiguredCdnResponsePolicyHeader(cache, name),
    };
  });
});

export type VinextBuildConfig = Effect.Success<
  ReturnType<typeof loadVinextBuildConfig>
>;
