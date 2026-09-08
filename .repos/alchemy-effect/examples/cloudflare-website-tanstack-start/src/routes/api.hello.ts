import { createFileRoute } from "@tanstack/react-router";
import * as Cloudflare from "alchemy/Cloudflare/Bridge";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type Backend from "../backend.ts";
import { env } from "../env.ts";

const VIAS = ["binding", "fetch", "rpc", "http-client"] as const;
type Via = (typeof VIAS)[number];

const parseRequest = (request: Request): { via: Via; key: string | null } => {
  const url = new URL(request.url);
  const raw = url.searchParams.get("via") ?? "binding";
  const via = (VIAS as readonly string[]).includes(raw)
    ? (raw as Via)
    : "binding";
  return { via, key: url.searchParams.get("key") };
};

// Surface the actual error in BOTH the response body and the worker logs —
// otherwise TanStack Start's outer boundary swallows it and you only ever
// see "HTTPError" in `bun alchemy logs`.
const trace = async (label: string, fn: () => Promise<Response>) => {
  try {
    return await fn();
  } catch (err) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[api.hello] ${label} failed:`, message);
    return new Response(`${label} failed: ${message}`, { status: 500 });
  }
};

export const Route = createFileRoute("/api/hello")({
  server: {
    handlers: {
      // GET /api/hello?key=<key>&via=binding|fetch|rpc
      GET: async ({ request }) => {
        const { via, key } = parseRequest(request);
        if (!key) {
          return new Response("Missing 'key' query parameter", { status: 400 });
        }

        switch (via) {
          // option 1 — use the async binding directly
          case "binding":
            return trace("GET option 1 (env.BUCKET.get)", async () => {
              const object = await env.BUCKET.get(key);
              if (!object) return new Response("Not found", { status: 404 });
              return new Response(object.body);
            });

          // option 2 — bind to your effect worker and call fetch
          case "fetch":
            return trace("GET option 2 (env.BACKEND.fetch)", async () => {
              const res = await env.BACKEND.fetch(
                `https://backend/?key=${encodeURIComponent(key)}`,
              );
              return new Response(res.body, {
                status: res.status,
                headers: res.headers,
              });
            });

          // option 3 — bind to your effect worker and call rpc method
          case "rpc":
            return trace("GET option 3 (backend.hello rpc)", async () => {
              // Wrap the raw wire-shape binding into a Promise<T> view that
              // throws on Effect.fail and unwraps stream envelopes.
              const backend = Cloudflare.toRpcAsync<Backend>(env.BACKEND);
              const value = await backend.hello(key);
              if (value === null)
                return new Response("Not found", { status: 404 });
              return new Response(value);
            });

          // option 4 — bind to your effect worker and call http client
          case "http-client":
            return trace("GET option 4 (env.BACKEND.httpClient)", async () => {
              const client = Cloudflare.toHttpClient(
                Cloudflare.fromCloudflareFetcher(env.BACKEND),
              );
              const res = await client
                .get(`https://backend/?key=${encodeURIComponent(key)}`)
                .pipe(Effect.runPromise);
              return HttpServerResponse.toWeb(
                HttpServerResponse.fromClientResponse(res),
              );
            });
        }
      },

      // PUT /api/hello?key=<key>&via=binding|fetch
      // (option 3 is GET-only — `hello` is a read RPC for demonstration.)
      PUT: async ({ request }) => {
        const { via, key } = parseRequest(request);
        if (!key) {
          return new Response("Missing 'key' query parameter", { status: 400 });
        }
        if (!request.body) {
          return new Response("Missing request body", { status: 400 });
        }

        switch (via) {
          // option 1 — use the async binding directly
          case "binding":
            return trace("PUT option 1 (env.BUCKET.put)", async () => {
              await env.BUCKET.put(key, request.body, {
                httpMetadata: {
                  contentType:
                    request.headers.get("content-type") ??
                    "application/octet-stream",
                },
              });
              return new Response(null, { status: 204 });
            });

          // option 2 — bind to your effect worker and call fetch
          case "fetch":
            return trace("PUT option 2 (env.BACKEND.fetch)", async () => {
              const res = await env.BACKEND.fetch(
                `https://backend/?key=${encodeURIComponent(key)}`,
                {
                  method: "PUT",
                  body: request.body,
                  headers: request.headers,
                },
              );
              return new Response(res.body, {
                status: res.status,
                headers: res.headers,
              });
            });

          // option 3 — RPC `hello` is read-only
          case "rpc":
            return new Response("PUT is not supported via=rpc", {
              status: 400,
            });

          // option 4 — bind to your effect worker and call http client
          case "http-client":
            return trace("PUT option 4 (env.BACKEND.httpClient)", async () => {
              const client = Cloudflare.toHttpClient(
                Cloudflare.fromCloudflareFetcher(env.BACKEND),
              );
              const res = await client
                .execute(HttpClientRequest.fromWeb(request))
                .pipe(Effect.runPromise);
              return HttpServerResponse.toWeb(
                HttpServerResponse.fromClientResponse(res),
                { withoutBody: res.status === 204 },
              );
            });
        }
      },
    },
  },
});
