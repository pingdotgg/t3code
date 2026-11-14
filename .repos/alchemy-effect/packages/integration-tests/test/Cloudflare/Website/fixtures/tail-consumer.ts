/**
 * Tail consumer for the Website dev tail tests: records every `tail()` batch
 * and every `tailStream()` session into KV and serves them on `/events`.
 */

interface EventsKV {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

interface Env {
  EVENTS: EventsKV;
}

interface StreamEvent {
  invocationId?: string;
  event?: { type?: string };
}

const read = async (env: Env, prefix: string) => {
  const list = await env.EVENTS.list({ prefix });
  const values = await Promise.all(list.keys.map((key) => env.EVENTS.get(key.name)));
  return values.filter((value): value is string => value !== null);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/events") {
      return Response.json({
        tail: await read(env, "tail:"),
        stream: await read(env, "stream:"),
      });
    }
    return new Response("tail-consumer-ok");
  },
  async tail(events: unknown[], env: Env): Promise<void> {
    await env.EVENTS.put(`tail:${crypto.randomUUID()}`, JSON.stringify(events));
  },
  tailStream(onset: StreamEvent, env: Env) {
    const events: StreamEvent[] = [onset];
    return async (event: StreamEvent) => {
      events.push(event);
      if (event.event?.type === "outcome") {
        await env.EVENTS.put(`stream:${crypto.randomUUID()}`, JSON.stringify(events));
      }
    };
  },
};
