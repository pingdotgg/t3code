import * as Effect from "effect/Effect";
import type { Plugin, PluginOption } from "vite";
import { loadProjectModule } from "../../core/Loader.ts";
import { loadVinextModule } from "../Modules.ts";

export type VinextCacheKind = "redis" | "s3" | "kv";

export interface VinextCacheOptions {
  data?: { adapter: string; options?: Record<string, unknown> };
  cdn?: { adapter: string; options?: Record<string, unknown> };
}

interface CacheModule {
  VIRTUAL_CACHE_ADAPTERS: string;
  VIRTUAL_CDN_CACHE_ADAPTER: string;
  findVinextCacheConfigInPlugins(
    plugins: PluginOption[] | undefined,
  ): Promise<VinextCacheOptions | null>;
  generateCacheAdaptersModule(cache: VinextCacheOptions): string;
  generateCdnCacheAdapterModule(cache: VinextCacheOptions): string;
}

/** The deploy target owns data caching; native CDN configuration is preserved. */
export const makeVinextCachePlugin = Effect.fn(function* (
  root: string,
  kind: VinextCacheKind,
) {
  const native = yield* loadVinextModule<CacheModule>(
    root,
    "cache/cache-adapters-virtual.js",
  );
  const { kvAdapter, redisAdapter, s3Adapter } = yield* loadProjectModule<
    typeof import("./index.ts")
  >(root, "@alchemy.run/frontend-frameworks/vinext/cache");
  const data =
    kind === "kv" ? kvAdapter() : kind === "s3" ? s3Adapter() : redisAdapter();
  let cache: VinextCacheOptions = { data };
  const adaptersId = "\0alchemy:vinext-cache-adapters";
  const cdnId = "\0alchemy:vinext-cdn-cache-adapter";
  return {
    name: "alchemy:vinext-cache",
    enforce: "pre",
    async configResolved(config) {
      const configured = await native.findVinextCacheConfigInPlugins([
        ...config.plugins,
      ]);
      if (configured?.data && configured.data.adapter !== data.adapter) {
        config.logger.warn(
          "[alchemy] Website.Vinext owns the data-cache adapter; the adapter in vite.config is overridden.",
        );
      }
      cache = { ...configured, data };
    },
    resolveId: {
      order: "pre",
      handler(id) {
        if (id === native.VIRTUAL_CACHE_ADAPTERS) return adaptersId;
        if (id === native.VIRTUAL_CDN_CACHE_ADAPTER) return cdnId;
      },
    },
    load(id) {
      if (id === adaptersId) return native.generateCacheAdaptersModule(cache);
      if (id === cdnId) return native.generateCdnCacheAdapterModule(cache);
    },
  } satisfies Plugin;
});
