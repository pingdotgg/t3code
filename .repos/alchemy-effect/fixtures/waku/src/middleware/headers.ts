// Managed-mode middleware (`src/middleware/*.ts`): waku's managed server
// entry collects these via `import.meta.glob` and hands them to the adapter,
// which runs them (via `middlewareRunner`) ahead of the RSC middleware for
// every worker-handled request. Sets a response header the smoke test
// asserts in both live and dev modes.
import type { Context } from "hono";

export default function headersMiddleware(_opts: unknown) {
  return async (c: Context, next: () => Promise<void>) => {
    await next();
    c.res.headers.set("x-waku-middleware", "fixtures-waku");
  };
}
