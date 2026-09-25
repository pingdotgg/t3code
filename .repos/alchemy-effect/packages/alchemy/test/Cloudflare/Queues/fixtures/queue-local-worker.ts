// Async (non-Effect) Worker that produces to a queue binding AND consumes
// the same queue, recording delivered bodies in instance memory so the test
// can poll them back over HTTP. Producer + consumer in one worker is the
// supported local shape: the broker lives in the consuming instance.
interface Env {
  QUEUE: {
    send(body: unknown, options?: { contentType?: string }): Promise<void>;
    sendBatch(
      messages: Iterable<{ body: unknown; contentType?: string }>,
    ): Promise<void>;
  };
}

interface MessageLike {
  body: unknown;
}

const received: string[] = [];
const batches: number[] = [];

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/plain") {
      return Response.json({ ok: true });
    }
    if (url.pathname === "/send") {
      const text = url.searchParams.get("text") ?? "hello";
      await env.QUEUE.send(text, { contentType: "text" });
      return Response.json({ sent: text });
    }
    if (url.pathname === "/sendbatch") {
      const text = url.searchParams.get("text") ?? "hello";
      await env.QUEUE.sendBatch([
        { body: `${text}-a`, contentType: "text" },
        { body: { text, index: 2 }, contentType: "json" },
      ]);
      return Response.json({ sent: 2 });
    }
    if (url.pathname === "/received") {
      return Response.json({ received });
    }
    if (url.pathname === "/batches") {
      return Response.json({ batches });
    }
    return new Response("not found", { status: 404 });
  },
  queue: async (batch: { messages: MessageLike[] }) => {
    batches.push(batch.messages.length);
    for (const message of batch.messages) {
      received.push(String(message.body));
    }
  },
};
