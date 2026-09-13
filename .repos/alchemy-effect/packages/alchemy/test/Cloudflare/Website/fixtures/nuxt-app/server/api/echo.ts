// POST route: echoes the JSON request body back alongside the
// TEST_BINDING read from nitro's cloudflare_module runtime contract —
// proves request bodies flow through the deployed worker (h3's readBody)
// and bindings are visible on non-GET routes.
export default defineEventHandler(async (event) => {
  const env = (
    event.context.cloudflare as { env?: Record<string, unknown> } | undefined
  )?.env;
  const echoed = event.method === "POST" ? await readBody(event) : null;
  return {
    method: event.method,
    echoed,
    binding: typeof env?.TEST_BINDING === "string" ? env.TEST_BINDING : null,
  };
});
