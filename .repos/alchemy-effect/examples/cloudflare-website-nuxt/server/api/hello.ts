// An ordinary nitro API route. `event.context.cloudflare` is the
// cloudflare_module preset's runtime contract: `{ request, env, context }`
// plus `event.context.cf` (the request's cf object).
export default defineEventHandler((event) => {
  const env = event.context.cloudflare?.env as
    | Record<string, unknown>
    | undefined;
  return {
    greeting: typeof env?.GREETING === "string" ? env.GREETING : null,
  };
});
