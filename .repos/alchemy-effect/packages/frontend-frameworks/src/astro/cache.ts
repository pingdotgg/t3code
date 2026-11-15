// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Vendored from `@astrojs/cloudflare` v14.4.2 (`src/cache/index.ts`).
 */
import type { CacheProviderConfig } from "astro";

/** The module Astro loads into the Worker as the cache provider. */
export const CACHE_PROVIDER_ENTRYPOINT = "@alchemy.run/frontend-frameworks/astro/cache/provider";

/**
 * Configure the Cloudflare Workers cache provider for Astro route caching.
 *
 * Responses carry `Cloudflare-CDN-Cache-Control` and `Cache-Tag` headers for
 * Cloudflare's Workers Cache. Each response is tagged with its request path,
 * so path and tag invalidation both purge by tag through the Worker cache
 * API. When the Worker has a `CF_VERSION_METADATA` binding, responses also
 * carry the Worker version as an `astro-version:` tag.
 *
 * `Cloudflare.Website.Astro` turns on Workers Cache for the Worker when the
 * Astro config uses this provider.
 *
 * ```js
 * // astro.config.mjs
 * import { defineConfig } from "astro/config";
 * import { cacheCloudflare } from "@alchemy.run/frontend-frameworks/astro/cache";
 *
 * export default defineConfig({
 *   cache: { provider: cacheCloudflare() },
 *   routeRules: { "/blog/[...path]": { maxAge: 600, swr: 86400 } },
 * });
 * ```
 */
export function cacheCloudflare(): CacheProviderConfig {
  return {
    name: "cloudflare",
    entrypoint: CACHE_PROVIDER_ENTRYPOINT,
  };
}

/**
 * Whether an Astro config uses the Cloudflare cache provider: this
 * package's {@link cacheCloudflare} or upstream `@astrojs/cloudflare/cache`'s
 * (both are named `"cloudflare"`).
 */
export const usesCloudflareCacheProvider = (config: unknown): boolean =>
  typeof config === "object" &&
  config !== null &&
  "cache" in config &&
  typeof config.cache === "object" &&
  config.cache !== null &&
  "provider" in config.cache &&
  typeof config.cache.provider === "object" &&
  config.cache.provider !== null &&
  "name" in config.cache.provider &&
  config.cache.provider.name === "cloudflare";
