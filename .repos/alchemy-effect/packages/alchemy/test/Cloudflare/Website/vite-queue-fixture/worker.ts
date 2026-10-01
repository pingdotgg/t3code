// Vite site worker that produces to a queue binding AND consumes the same
// queue (the shape from issue #1109): API routes handle the produce/poll,
// everything else falls through to the assets worker.
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  QUEUE: {
    send(body: unknown, options?: { contentType?: string }): Promise<void>;
  };
}

interface MessageLike {
  body: unknown;
}

const received: string[] = [];

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/send") {
      const text = url.searchParams.get("text") ?? "hello";
      await env.QUEUE.send(text, { contentType: "text" });
      return Response.json({ sent: text });
    }
    if (url.pathname === "/api/received") {
      return Response.json({ received });
    }
    return env.ASSETS.fetch(request);
  },
  queue: async (batch: { messages: MessageLike[] }) => {
    for (const message of batch.messages) {
      received.push(String(message.body));
    }
  },
};
