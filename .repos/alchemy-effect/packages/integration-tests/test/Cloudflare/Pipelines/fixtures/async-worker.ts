import type { AsyncWorkerEnv } from "./stack.ts";

export default {
  async fetch(request: Request, env: AsyncWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      await env.EVENTS.send([
        {
          source: "pipelines-binding-test",
          nonce: url.searchParams.get("nonce") ?? "none",
        },
      ]);
      return Response.json({
        mode: "async",
        sent: true,
        kind: typeof env.EVENTS.send,
      });
    }
    return Response.json({
      mode: "async",
      sent: false,
      kind: typeof env.EVENTS.send,
    });
  },
};
