/**
 * McpTunnelProxy — the only thing the managed tunnel is allowed to see.
 *
 * A tunnel forwards to a port, and the server's main port carries far more
 * than MCP: the WebSocket RPC surface, pairing endpoints, discovery routes.
 * Pointing cloudflared at it would publish all of that to the internet to get
 * one path. So the tunnel points here instead: a loopback listener that
 * forwards `/mcp` (and its health probe `HEAD`/`GET`) to the real server and
 * answers 404 to every other path before any bytes reach it.
 *
 * The proxy adds no auth of its own — `/mcp` behind it is already
 * bearer-gated by `McpHttpServer`, and duplicating that check here would rot.
 * Its one job is making "publicly reachable" and "the MCP endpoint" the same
 * set.
 *
 * @module mcp/McpTunnelProxy
 */
// @effect-diagnostics nodeBuiltinImport:off
// Raw node:http on purpose: this is a byte-level forwarder (including SSE
// streaming responses), not an application route, and it must not share a
// router or middleware with the app it is shielding.
import * as NodeHttp from "node:http";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class McpTunnelProxyError extends Schema.TaggedErrorClass<McpTunnelProxyError>()(
  "McpTunnelProxyError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface McpTunnelProxyHandle {
  /** Loopback port the tunnel should forward to. */
  readonly port: number;
}

const FORWARDED_PATH = "/mcp";

const isAllowedPath = (url: string | undefined): boolean => {
  if (!url) return false;
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path === FORWARDED_PATH;
};

/**
 * Starts the proxy on an ephemeral loopback port. Scoped: closing the scope
 * closes the listener and every in-flight upstream request with it.
 */
export const startMcpTunnelProxy = (input: {
  readonly upstreamPort: number;
  readonly upstreamHost?: string;
}): Effect.Effect<McpTunnelProxyHandle, McpTunnelProxyError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server, McpTunnelProxyError>((resume) => {
      const upstreamHost = input.upstreamHost ?? "127.0.0.1";
      const server = NodeHttp.createServer((request, response) => {
        if (!isAllowedPath(request.url)) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        const upstream = NodeHttp.request(
          {
            host: upstreamHost,
            port: input.upstreamPort,
            method: request.method,
            path: request.url,
            headers: { ...request.headers, host: `${upstreamHost}:${input.upstreamPort}` },
          },
          (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
          },
        );
        upstream.on("error", () => {
          if (!response.headersSent) {
            response.writeHead(502, { "content-type": "application/json" });
          }
          response.end(JSON.stringify({ error: "upstream_unavailable" }));
        });
        request.pipe(upstream);
      });
      server.on("error", (error) =>
        resume(Effect.fail(new McpTunnelProxyError({ detail: String(error) }))),
      );
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        // Idle keep-alive sockets would otherwise hold `close` open for its
        // full timeout during shutdown.
        server.closeAllConnections();
      }),
  ).pipe(
    Effect.flatMap((server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.fail(
          new McpTunnelProxyError({ detail: "MCP tunnel proxy bound to a non-TCP address" }),
        );
      }
      return Effect.succeed({ port: address.port });
    }),
  );

/** Exposed for tests. */
export const __testing = { isAllowedPath };
