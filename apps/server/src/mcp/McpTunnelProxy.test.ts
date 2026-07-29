// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off preferSchemaOverJson:off
// Raw fetch/JSON on purpose: the assertion is about what an arbitrary HTTP
// client on the public internet sees, so the test client must not share
// plumbing with the server under test.
import * as NodeHttp from "node:http";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { __testing, startMcpTunnelProxy } from "./McpTunnelProxy.ts";

it("allows exactly the /mcp path, with or without a query", () => {
  expect(__testing.isAllowedPath("/mcp")).toBe(true);
  expect(__testing.isAllowedPath("/mcp?k=token")).toBe(true);
  expect(__testing.isAllowedPath("/")).toBe(false);
  expect(__testing.isAllowedPath("/mcp/extra")).toBe(false);
  expect(__testing.isAllowedPath("/mcpx")).toBe(false);
  expect(__testing.isAllowedPath("/ws")).toBe(false);
  expect(__testing.isAllowedPath("/.well-known/t3/environment")).toBe(false);
  expect(__testing.isAllowedPath(undefined)).toBe(false);
});

const startUpstream = Effect.acquireRelease(
  Effect.callback<NodeHttp.Server>((resume) => {
    const server = NodeHttp.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ path: request.url, header: request.headers.authorization }));
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
      server.closeAllConnections();
    }),
);

const fetchStatus = (port: number, path: string, headers?: Record<string, string>) =>
  Effect.promise(async () => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: headers ?? {},
    });
    return { status: response.status, body: await response.text() };
  });

it.live("forwards /mcp with headers intact and refuses every other path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* startUpstream;
      const address = upstream.address();
      if (address === null || typeof address === "string") throw new Error("no port");

      const proxy = yield* startMcpTunnelProxy({ upstreamPort: address.port });

      const forwarded = yield* fetchStatus(proxy.port, "/mcp?k=tok", {
        authorization: "Bearer abc",
      });
      expect(forwarded.status).toBe(200);
      // The upstream saw the same path, query, and auth header the tunnel
      // client sent — the proxy is a forwarder, not a rewriter.
      expect(JSON.parse(forwarded.body)).toEqual({ path: "/mcp?k=tok", header: "Bearer abc" });

      // Everything else 404s at the proxy without touching the upstream —
      // this is the property that makes the public tunnel safe to run.
      for (const path of ["/", "/ws", "/mcp/extra", "/.well-known/t3/environment"]) {
        const refused = yield* fetchStatus(proxy.port, path);
        expect(refused.status).toBe(404);
      }
    }),
  ),
);

it.live("answers 502 when the upstream is down instead of hanging", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Port 1 on loopback: reserved, nothing listens there.
      const proxy = yield* startMcpTunnelProxy({ upstreamPort: 1 });
      const result = yield* fetchStatus(proxy.port, "/mcp");
      expect(result.status).toBe(502);
    }),
  ),
);
