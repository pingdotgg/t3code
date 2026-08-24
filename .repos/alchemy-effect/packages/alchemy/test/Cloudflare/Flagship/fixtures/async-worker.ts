import type { AsyncWorkerEnv } from "./stack.ts";

/**
 * Async (non-Effect) Worker fixture for the Cloudflare Flagship binding
 * declared via `env: { FLAGS: App }` with a `FlagshipApp` resource. `InferEnv`
 * maps the resource to the native `Flagship` runtime binding, so the handler
 * calls `env.FLAGS.getBooleanValue(...)` directly.
 */
export default {
  async fetch(request: Request, env: AsyncWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/bool")) {
      const enabled = await env.FLAGS.getBooleanValue("test-flag", false, {
        userId: "user-42",
      });
      return Response.json({ mode: "async", enabled });
    }

    if (url.pathname.startsWith("/details")) {
      const details = await env.FLAGS.getStringDetails(
        "nonexistent-flag",
        "fallback",
        { userId: "user-42" },
      );
      return Response.json({ mode: "async", details });
    }

    return new Response("ok");
  },
};
