// Managed-mode middleware (`src/middleware/*.ts`): waku's managed server
// entry collects these via `import.meta.glob` and hands them to the adapter,
// which runs them ahead of the RSC middleware for every worker-handled
// request. Sets a response header the tests assert on the dynamic SSR page
// in both live and dev modes (static assets bypass the worker by design).
import type { Context } from "hono";

export default function headersMiddleware(_opts: unknown) {
  return async (c: Context, next: () => Promise<void>) => {
    await next();
    c.res.headers.set("x-waku-middleware", "alchemy-waku-fixture");
  };
}
