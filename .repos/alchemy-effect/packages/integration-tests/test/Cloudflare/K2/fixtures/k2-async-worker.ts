import type { K2AsyncWorkerEnv } from "./k2-async-stack.ts";

const encoder = new TextEncoder();

/**
 * `POST /send?run=R&count=N` appends N records through `env.ORDERS.send`
 * (the native `k2` binding) and answers 202, or 500 with the binding's
 * error when the append failed.
 */
export default {
  async fetch(request: Request, env: K2AsyncWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/send") {
      return new Response("Not Found", { status: 404 });
    }
    const run = url.searchParams.get("run") ?? "default";
    const count = Number(url.searchParams.get("count") ?? "1");
    const result = await env.ORDERS.send(
      Array.from({ length: count }, (_, index) => ({
        content: encoder.encode(`${run}:${index}`),
        headers: { run },
      })),
    );
    return result.success
      ? Response.json({ produced: count }, { status: 202 })
      : Response.json({ error: result.error }, { status: 500 });
  },
};
