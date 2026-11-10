import type { MiddlewareHandler } from "astro";

/**
 * Astro middleware: runs inside workerd for every on-demand route (dev +
 * live). Stamps a fresh per-request id into `Astro.locals` (rendered by the
 * SSR pages, proving each request renders anew) and mirrors it onto the
 * outgoing response headers.
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  const requestId = crypto.randomUUID();
  context.locals.requestId = requestId;
  const response = await next();
  response.headers.set("x-request-id", requestId);
  response.headers.set("x-middleware", "hit");
  return response;
};
