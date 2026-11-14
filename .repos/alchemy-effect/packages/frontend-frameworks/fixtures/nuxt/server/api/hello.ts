// An ordinary nitro API route. `event.context.cloudflare` is the
// cloudflare_module preset's runtime contract: `{ request, env, context }`
// plus `event.context.cf` (the request's cf object).
export default defineEventHandler((event) => {
  const cloudflare = event.context.cloudflare as
    | {
        env?: Record<string, unknown>;
        context?: { waitUntil?: unknown };
      }
    | undefined;
  return {
    marker: "api-route-ok",
    secret:
      typeof cloudflare?.env?.FIXTURE_SECRET === "string" ? cloudflare.env.FIXTURE_SECRET : null,
    hasWaitUntil: typeof cloudflare?.context?.waitUntil === "function",
  };
});
