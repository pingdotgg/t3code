import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/**
 * `platform.caches` access path.
 *
 * - **live** (workerd): `platform.caches.default` is the real Cache API — the
 *   first request for a key computes and `put`s, the second is a cache hit.
 * - **dev** (Node SSR): cloudflare-runtime's platform proxy backs `caches`
 *   with an in-memory store in the proxy worker, so `put`/`match` round-trip
 *   the same way (unlike wrangler's `getPlatformProxy`, whose dev cache is a
 *   no-op).
 */
export const GET: RequestHandler = async ({ platform, url }) => {
  const key = url.searchParams.get("key") ?? "default";
  const cache = platform?.caches?.default;
  if (cache === undefined) {
    return json({ supported: false, cached: false, key });
  }
  const cacheKey = `https://cache.fixture.invalid/${encodeURIComponent(key)}`;
  const hit = await cache.match(cacheKey);
  if (hit !== undefined) {
    return json({ supported: true, cached: true, key });
  }
  await cache.put(
    cacheKey,
    new Response(JSON.stringify({ key }), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=60",
      },
    }),
  );
  return json({ supported: true, cached: false, key });
};
