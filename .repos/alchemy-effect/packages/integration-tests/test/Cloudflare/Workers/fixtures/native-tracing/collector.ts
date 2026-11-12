/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

// OTLP/HTTP collector for the native tracer's export test. Cloudflare's
// observability destination pushes Workers traces here; each POST body is
// stored under its own key (a batch can exceed one value's size limit) so
// the test can read every export back via GET /collected.
export class TraceSink extends DurableObject {
  async add(body: string) {
    await this.ctx.storage.put(`item:${crypto.randomUUID()}`, body);
  }

  async list() {
    return [...(await this.ctx.storage.list<string>({ prefix: "item:" })).values()];
  }
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const sink = env.SINK.get(env.SINK.idFromName("collector"));
    if (request.method === "POST") {
      // The destination preflight posts too; store whatever arrives and
      // always answer 2xx. Exports arrive gzip-encoded.
      const body =
        request.headers.get("content-encoding") === "gzip" && request.body
          ? await new Response(request.body.pipeThrough(new DecompressionStream("gzip"))).text()
          : await request.text();
      await sink.add(body);
      return Response.json({ partialSuccess: {} });
    }
    if (new URL(request.url).pathname === "/collected") {
      return Response.json({ marker: "trace-collector-ok", items: await sink.list() });
    }
    return new Response("trace-collector-ok");
  },
};
