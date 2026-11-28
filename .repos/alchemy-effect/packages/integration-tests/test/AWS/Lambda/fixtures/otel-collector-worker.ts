/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

// Minimal OTLP "collector" fixture for AWS/Lambda/Telemetry.test.ts. OTLP/HTTP JSON
// posts to /v1/{traces,logs,metrics} are appended to a Durable Object so
// the test can read everything back from any isolate via GET /collected.
export class OtelSink extends DurableObject {
  async add(entry: unknown) {
    const items = (await this.ctx.storage.get<unknown[]>("items")) ?? [];
    items.push(entry);
    await this.ctx.storage.put("items", items);
  }

  async list() {
    return (await this.ctx.storage.get<unknown[]>("items")) ?? [];
  }
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const sink = env.SINK.get(env.SINK.idFromName("collector"));
    if (request.method === "POST" && url.pathname.startsWith("/v1/")) {
      // Record every push, even an unparseable one, so the test can tell
      // "export never sent" apart from "export sent but malformed".
      const raw = await request.text();
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { parseError: true, raw: raw.slice(0, 1000) };
      }
      await sink.add({
        signal: url.pathname.slice("/v1/".length),
        payload,
      });
      return Response.json({ partialSuccess: {} });
    }
    if (url.pathname === "/collected") {
      return Response.json({
        marker: "otel-collector-ok",
        items: await sink.list(),
      });
    }
    return new Response("otel-collector-ok");
  },
};
