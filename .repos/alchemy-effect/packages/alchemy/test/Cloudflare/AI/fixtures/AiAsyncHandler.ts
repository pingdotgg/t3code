import type { AiAsyncWorkerEnv } from "./AiAsyncWorker.ts";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export default {
  async fetch(request: Request, env: AiAsyncWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const prompt =
      url.searchParams.get("prompt") ??
      "Say the single word 'pong' and nothing else.";

    if (url.pathname === "/run") {
      const result = await env.AI.run(MODEL, {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 128,
      });
      return Response.json({ mode: "async", result });
    }

    if (url.pathname === "/models") {
      const models = await env.AI.models({ search: "llama-3.3" });
      return Response.json({
        mode: "async",
        count: models.length,
        names: models.map((m) => m.name),
      });
    }

    return new Response("ok");
  },
};
