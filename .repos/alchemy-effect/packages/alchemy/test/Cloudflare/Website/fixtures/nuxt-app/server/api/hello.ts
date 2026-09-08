// An ordinary nitro API route. `event.context.cloudflare` is the
// cloudflare_module preset's runtime contract: `{ request, env, context }`
// plus `event.context.cf` (the request's cf object).
//
// NOTE: this file uses nitro's auto-imported globals (`defineEventHandler`),
// so the fixture directory is excluded from the alchemy test project's
// type-check (packages/alchemy/tsconfig.test.json) — nitro's generated
// types only exist after a nuxt build.
export default defineEventHandler((event) => {
  const cloudflare = event.context.cloudflare as
    | {
        env?: Record<string, unknown>;
        context?: { waitUntil?: unknown };
      }
    | undefined;
  return {
    marker: "api-route-ok",
    binding:
      typeof cloudflare?.env?.TEST_BINDING === "string"
        ? cloudflare.env.TEST_BINDING
        : null,
    hasWaitUntil: typeof cloudflare?.context?.waitUntil === "function",
  };
});
