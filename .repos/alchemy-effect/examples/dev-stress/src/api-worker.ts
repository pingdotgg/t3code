/**
 * Path-`main` Worker: the stack declares it as
 * `Cloudflare.Worker("ApiWorker", { main: "./src/api-worker.ts", … })` and
 * never imports this module. `bun --watch` therefore cannot see it, so an
 * edit here travels the OTHER dev reload path — the local Worker
 * provider's bundler watch loop rebuilds and hot-swaps the script while the
 * exec child, the plan, and every other resource stay exactly as they are.
 *
 * Deliberately free of `alchemy` imports so the bundle graph is tiny and
 * the measured rebuild latency is the dev server's, not rolldown's.
 *
 * Routes:
 *   - `GET /marker` → marker + the movable module's value
 *   - `GET /kv`     → native KV binding roundtrip
 *   - `GET /env`    → plain vars, including the cross-cloud Lambda URL
 *   - `GET /aws/*`  → CROSS-CLOUD: fetches the AWS Lambda function URL
 *                     served by the floci emulator over its own TLS cert
 */
import { API_MARKER } from "./api/marker.ts";
import { message } from "./api/message.ts";

interface KVNamespaceLike {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
}

interface Env {
  KV: KVNamespaceLike;
  API_VARIABLE: string;
  /** Added and removed by the binding-churn phase; absent most of the time. */
  API_EXTRA?: string;
  /** The cross-cloud edge; absent while the AWS half is deleted. */
  AWS_LAMBDA_URL?: string;
}

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);

    if (url.pathname === "/marker") {
      return Response.json({ marker: API_MARKER, message: message() });
    }

    if (url.pathname === "/kv") {
      const key = url.searchParams.get("key") ?? "hello";
      await env.KV.put(key, `kv:${key}`);
      return Response.json({ value: await env.KV.get(key) });
    }

    if (url.pathname === "/env") {
      return Response.json({
        API_VARIABLE: env.API_VARIABLE ?? null,
        API_EXTRA: env.API_EXTRA ?? null,
        AWS_LAMBDA_URL: env.AWS_LAMBDA_URL ?? null,
      });
    }

    if (url.pathname.startsWith("/aws")) {
      // Cross-cloud hop: local workerd → the AWS Lambda's function URL,
      // which under `alchemy dev` is served by the floci emulator behind a
      // self-signed cert. It only resolves because `alchemy dev` puts the
      // emulator CA on NODE_EXTRA_CA_CERTS for every process it spawns.
      const base = env.AWS_LAMBDA_URL;
      if (!base) return Response.json({ error: "no lambda url" }, { status: 503 });
      const target = new URL(url.pathname.slice("/aws".length) || "/", base);
      target.search = url.search;
      const upstream = await fetch(target, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: request.method === "GET" ? undefined : await request.text(),
      });
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      });
    }

    return Response.json({ marker: API_MARKER });
  },
};
