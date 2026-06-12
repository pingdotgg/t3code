import type { AsyncWorkerEnv } from "./stack.ts";

/**
 * Async (non-Effect) Worker fixture for the Cloudflare Images binding declared
 * via `env: { MEDIA: Cloudflare.Images(...) }`. `InferEnv` maps the marker to
 * the native `cf.ImagesBinding`, so the handler calls `env.MEDIA.info(...)`
 * directly with the request body's `ReadableStream`.
 */
export default {
  async fetch(request: Request, env: AsyncWorkerEnv): Promise<Response> {
    const info = await env.MEDIA.info(request.body!);
    return Response.json({ mode: "async", ...info });
  },
};
