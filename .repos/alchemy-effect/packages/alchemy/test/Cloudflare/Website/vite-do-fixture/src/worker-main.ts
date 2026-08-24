import worker from "./worker.ts";

export { Counter } from "./worker.ts";

/**
 * Alternate Worker entry used by the `main` override test. It hosts the
 * same Durable Object but additionally answers `/api/entry`, so the test
 * can prove the deployed entry came from the `main` option — not from the
 * entry configured in `vite.config.ts` (which points at `worker.ts`).
 */
export default {
  async fetch(
    request: Request,
    env: Parameters<typeof worker.fetch>[1],
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/entry") {
      return Response.json({ entry: "worker-main" });
    }

    return worker.fetch(request, env);
  },
};
