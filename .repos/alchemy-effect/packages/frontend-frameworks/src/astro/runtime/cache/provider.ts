// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Vendored from `@astrojs/cloudflare` v14.4.2 (`src/cache/provider.ts`).
 *
 * The Cloudflare cache provider Astro loads into the Worker when the config
 * uses `cacheCloudflare()`.
 */
import type { CacheProviderFactory } from "astro";
import {
  buildCacheControlDirectives,
  collectInvalidationTags,
  pathTag,
  setConditionalHeaders,
} from "astro/cache/provider-utils";

const VERSION_TAG_PREFIX = "astro-version:";

/**
 * Read the Worker version id from the `CF_VERSION_METADATA` binding.
 *
 * A top-level `cloudflare:workers` import breaks the `prerenderEnvironment:
 * 'node'` build, so the module is imported dynamically. Resolving once at
 * module load keeps `setHeaders()` synchronous.
 */
async function readVersionId(): Promise<string | undefined> {
  try {
    const { env } = await import("cloudflare:workers");
    const metadata = (env as Record<string, unknown>).CF_VERSION_METADATA;
    if (metadata && typeof metadata === "object" && "id" in metadata) {
      const id = metadata.id;
      if (typeof id === "string" && id.length > 0) {
        return id;
      }
    }
  } catch {}
  return undefined;
}

const versionId = await readVersionId();

const factory: CacheProviderFactory = () => ({
  name: "cloudflare",
  setHeaders(options, request) {
    const headers = new Headers();
    // The adapter's request handler sets `no-store` on responses with no
    // cache intent, so this header is only emitted when there is something
    // cacheable to announce.
    const directives = buildCacheControlDirectives(options, ["public"]);
    if (directives) {
      headers.set("Cloudflare-CDN-Cache-Control", directives);
    }
    // Auto-tag with the request path for path-based invalidation via tag purge.
    const tags = [...(options.tags ?? [])];
    const { pathname } = new URL(request.url);
    tags.push(pathTag(pathname));
    if (versionId) {
      tags.push(`${VERSION_TAG_PREFIX}${versionId}`);
    }
    headers.set("Cache-Tag", tags.join(","));
    setConditionalHeaders(headers, options);
    // The validator stays weak: two responses from one version are
    // semantically equivalent, not byte-identical.
    if (versionId && options.lastModified && !options.etag) {
      headers.set("ETag", `W/"${versionId}:${options.lastModified.getTime()}"`);
    }
    return headers;
  },
  async invalidate(options) {
    // Imported lazily: a top-level `cloudflare:workers` import breaks the
    // `prerenderEnvironment: 'node'` build, where Node loads the provider
    // during prerendering and rejects the `cloudflare:` scheme.
    const { cache } = await import("cloudflare:workers");
    const tags = collectInvalidationTags(options);
    if (tags.length > 0) {
      await cache.purge({ tags });
    }
  },
});

export default factory;
