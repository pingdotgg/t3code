/**
 * Tail consumer for {@link AsyncWorker}. Listed in the producer's
 * `tailConsumers`, so every invocation of the producer delivers a trace
 * batch to `tail()`. Batches are recorded into a KV namespace and exposed
 * over `GET /events` so the integ test can assert the producer's
 * `console.log` marker arrived end-to-end.
 *
 * NOTE: the default export must be this module's ONLY export — extra named
 * exports become workerd top-level exports and fail startup validation.
 */
interface TailEventsKV {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

interface TraceItemLite {
  scriptName?: string | null;
  outcome?: string;
  logs?: { message?: unknown[]; level?: string; timestamp?: number }[];
}

export default {
  async fetch(
    request: Request,
    env: { EVENTS: TailEventsKV },
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/events") {
      const list = await env.EVENTS.list({ prefix: "evt:" });
      const batches = await Promise.all(
        list.keys.map((key) => env.EVENTS.get(key.name)),
      );
      return Response.json({
        keys: list.keys.map((key) => key.name),
        batches: batches.filter((batch): batch is string => batch !== null),
      });
    }
    return new Response("tail-consumer-ok");
  },
  async tail(
    events: TraceItemLite[],
    env: { EVENTS: TailEventsKV },
  ): Promise<void> {
    const producer = events[0]?.scriptName ?? "unknown";
    await env.EVENTS.put(
      `evt:${producer}:${Date.now()}`,
      JSON.stringify(events),
    );
  },
};
