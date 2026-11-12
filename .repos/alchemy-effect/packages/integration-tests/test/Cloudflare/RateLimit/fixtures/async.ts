import type { AsyncWorkerEnv } from "./stack.ts";

/**
 * Async (non-Effect) Worker handler that exercises the RateLimit binding
 * declared via `env: { THROTTLE: Cloudflare.RateLimit(...) }`. `InferEnv` maps
 * the binding to the native `cf.RateLimit`, so the handler calls
 * `env.THROTTLE.limit({ key })` directly.
 *
 * `/burst` calls the limiter `n` times within a single isolate so the
 * throttling is deterministic: with `limit: 2` the first two calls for a key
 * succeed and the rest are denied.
 */
export default {
  fetch: async (request: Request, env: AsyncWorkerEnv) => {
    const url = new URL(request.url);

    if (url.pathname === "/burst") {
      const key = url.searchParams.get("key") ?? "default";
      const n = Number(url.searchParams.get("n") ?? "5");

      const results: boolean[] = [];
      for (let i = 0; i < n; i++) {
        const { success } = await env.THROTTLE.limit({ key });
        results.push(success);
      }

      return new Response(JSON.stringify({ key, results }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("ok");
  },
};
