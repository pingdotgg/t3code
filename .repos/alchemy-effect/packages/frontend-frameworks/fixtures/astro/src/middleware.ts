import type { MiddlewareHandler } from "astro";

/**
 * Astro middleware: runs inside workerd for on-demand routes (dev + live).
 * Exercises both middleware surfaces — writing `Astro.locals` (read by
 * `/locals`) and mutating the outgoing response headers.
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  context.locals.fromMiddleware = "set-by-middleware";
  const response = await next();
  response.headers.set("x-middleware", "hit");
  return response;
};
