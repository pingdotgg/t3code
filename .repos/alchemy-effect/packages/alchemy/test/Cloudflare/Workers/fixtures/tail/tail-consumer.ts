/**
 * Async (non-Effect) Tail Worker fixture for `TailConsumers.test.ts` and
 * `TailConsumers.local.test.ts`.
 *
 * Cloudflare invokes the exported `tail()` handler with the trace items of
 * each invocation of any producer Worker that lists this script in its
 * `tail_consumers`. Every batch is persisted to the bound KV namespace under
 * a key prefixed with the *producing* script's name, so the live test
 * verifies delivery out-of-band (distilled KV reads) without depending on
 * which isolate served which request. The `/events` fetch route returns every
 * recorded batch for the local test, where no out-of-band KV API exists —
 * the local simulator is only reachable through the worker's own binding.
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
