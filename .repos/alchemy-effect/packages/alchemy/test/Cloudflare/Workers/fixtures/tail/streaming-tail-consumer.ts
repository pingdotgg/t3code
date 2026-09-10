/**
 * Async (non-Effect) streaming Tail Worker fixture for
 * `StreamingTailConsumers.test.ts` and `StreamingTailConsumers.local.test.ts`.
 *
 * Contract delta from the plain `tail-consumer.ts` fixture: Cloudflare
 * invokes the exported `tailStream()` handler with the invocation's `onset`
 * event while the producer is still executing, and the returned function
 * receives every subsequent event of the session (`log`, `spanOpen`, ...)
 * ending with the terminal `outcome`. On `outcome`, the whole recorded
 * session (onset included) is persisted to the bound KV namespace so both
 * the live test (out-of-band distilled KV reads) and the local test (the
 * `/events` fetch route below) can assert delivery.
 *
 * NOTE: the default export must be this module's ONLY export — extra named
 * exports become workerd top-level exports and fail startup validation.
 */

interface TailEventsKV {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

interface StreamTailEvent {
  invocationId?: string;
  timestamp?: string;
  sequence?: number;
  event?: {
    type?: string;
    outcome?: string;
    level?: string;
    message?: unknown;
    info?: { type?: string; url?: string; method?: string };
  };
}

export default {
  async fetch(
    request: Request,
    env: { EVENTS: TailEventsKV },
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/events") {
      const list = await env.EVENTS.list({ prefix: "evt:" });
      const sessions = await Promise.all(
        list.keys.map((key) => env.EVENTS.get(key.name)),
      );
      return Response.json({
        keys: list.keys.map((key) => key.name),
        sessions: sessions.filter(
          (session): session is string => session !== null,
        ),
      });
    }
    return new Response("streaming-tail-consumer-ok");
  },
  tailStream(
    onset: StreamTailEvent,
    env: { EVENTS: TailEventsKV },
  ): (tailEvent: StreamTailEvent) => Promise<void> {
    const events: StreamTailEvent[] = [onset];
    return async (tailEvent: StreamTailEvent): Promise<void> => {
      events.push(tailEvent);
      // `outcome` terminates the session — flush the full recording. The
      // key suffix is payload data (not a resource name), so wall-clock
      // uniqueness is fine here.
      if (tailEvent.event?.type === "outcome") {
        const id = onset.invocationId ?? `${Date.now()}`;
        await env.EVENTS.put(`evt:${id}:${Date.now()}`, JSON.stringify(events));
      }
    };
  },
};
