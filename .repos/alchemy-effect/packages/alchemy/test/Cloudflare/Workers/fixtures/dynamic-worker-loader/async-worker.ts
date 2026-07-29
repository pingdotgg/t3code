import type { AsyncWorkerEnv } from "./stack.ts";

/**
 * Async (non-Effect) Worker fixture for the Worker Loader binding declared via
 * `env: { LOADER: Cloudflare.WorkerLoader() }`. `InferEnv` maps the
 * marker to the native `worker_loader` binding, so the handler calls
 * `env.LOADER.load(...).getEntrypoint().fetch(...)` directly.
 */
export default {
  async fetch(request: Request, env: AsyncWorkerEnv): Promise<Response> {
    const worker = env.LOADER.load({
      compatibilityDate: "2026-01-28",
      mainModule: "worker.js",
      modules: {
        "worker.js": `export default {
          async fetch() {
            return Response.json({ mode: "async", ok: true });
          }
        }`,
      },
    });

    return worker.getEntrypoint().fetch(request);
  },
};
