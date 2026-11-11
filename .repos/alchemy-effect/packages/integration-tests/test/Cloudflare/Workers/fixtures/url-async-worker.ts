import type { UrlAsyncWorkerEnv } from "./url-stack.ts";

/**
 * Async (non-Effect) Worker fixture for the `Worker.URL` binding declared via
 * `env: { PUBLIC_URL: Cloudflare.Worker.URL }`. `InferEnv` maps the tag to
 * `string`, so the handler reads `env.PUBLIC_URL` directly.
 */
export default {
  async fetch(_request: Request, env: UrlAsyncWorkerEnv): Promise<Response> {
    return Response.json({ url: env.PUBLIC_URL });
  },
};
