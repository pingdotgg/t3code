import { parseOrigin } from "./origin.ts";

// Narrow binding interfaces keep this gateway independent of the Node server.
export interface Env {
  DB: {
    prepare(sql: string): {
      first<T>(): Promise<T | null>;
    };
  };
}

function unavailable(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export function createGateway(fetchUpstream: typeof fetch = fetch) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const publicUrl = new URL(request.url);
      let upstream: URL;
      try {
        const config = await env.DB.prepare(
          "SELECT upstream_origin FROM gateway_config WHERE id = 1",
        ).first<{ upstream_origin: string }>();
        if (!config) return unavailable(503, "Gateway is not configured.");
        // Wrangler local mode uses a local D1 and permits a loopback server.
        upstream = parseOrigin(
          config.upstream_origin,
          ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname),
        );
        if (upstream.origin === publicUrl.origin) {
          return unavailable(503, "Gateway upstream must be a different origin.");
        }
      } catch {
        return unavailable(503, "Gateway database or configuration is unavailable.");
      }

      // Assign path and search separately: a path starting with // must never
      // become an authority and redirect the request (and credentials) elsewhere.
      const target = new URL(upstream.origin);
      target.pathname = publicUrl.pathname;
      target.search = publicUrl.search;
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("forwarded");
      headers.delete("x-forwarded-for");
      headers.set("x-forwarded-host", publicUrl.host);
      headers.set("x-forwarded-proto", publicUrl.protocol.slice(0, -1));
      const clientIp = request.headers.get("cf-connecting-ip");
      if (clientIp) headers.set("x-forwarded-for", clientIp);

      try {
        // Forward the original stream and upgrade headers. Returning a 101
        // response unchanged lets Workers proxy WebSockets without a JS pump.
        const forwarded = new Request(target, request);
        const response = await fetchUpstream(
          new Request(forwarded, {
            headers,
            redirect: "manual",
          }),
        );
        if (response.status === 101) return response;

        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("cache-control", "no-store");
        const location = responseHeaders.get("location");
        if (location) {
          const redirect = new URL(location, target);
          if (redirect.origin === upstream.origin) {
            redirect.host = publicUrl.host;
            redirect.protocol = publicUrl.protocol;
            responseHeaders.set("location", redirect.href);
          }
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      } catch {
        return unavailable(502, "T3 server is unreachable.");
      }
    },
  };
}

export default createGateway();
