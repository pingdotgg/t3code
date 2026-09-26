import type { MiddlewareHandler } from "astro";

/**
 * Astro middleware: runs inside the Worker (live) / workerd (dev) for every
 * on-demand route. Stamps a fresh per-request id into `Astro.locals`
 * (rendered by `/locals`, proving middleware-set locals reach the page) and
 * mirrors it onto the outgoing response headers alongside a static marker.
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  const requestId = crypto.randomUUID();
  (context.locals as { requestId?: string }).requestId = requestId;
  const response = await next();
  response.headers.set("x-request-id", requestId);
  response.headers.set("x-middleware", "hit");
  return response;
};
