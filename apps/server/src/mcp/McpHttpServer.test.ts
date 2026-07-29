import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";

it("reads the credential from the Authorization header, then the URL", () => {
  const bearer = "header-token";
  const query = "query-token";

  expect(McpHttpServer.readRequestToken({ authorization: `Bearer ${bearer}`, url: "/mcp" })).toBe(
    bearer,
  );

  // ChatGPT Developer Mode connectors cannot send a custom header, so the
  // credential arrives in the URL instead.
  expect(McpHttpServer.readRequestToken({ authorization: undefined, url: `/mcp?k=${query}` })).toBe(
    query,
  );

  // The header wins when both are present; a stale URL cannot downgrade a
  // caller that authenticated properly.
  expect(
    McpHttpServer.readRequestToken({
      authorization: `Bearer ${bearer}`,
      url: `/mcp?k=${query}`,
    }),
  ).toBe(bearer);
});

it("treats missing, malformed, and empty credentials as no credential", () => {
  for (const input of [
    { authorization: undefined, url: "/mcp" },
    { authorization: "", url: "/mcp" },
    { authorization: "Basic abc", url: "/mcp" },
    { authorization: "Bearer    ", url: "/mcp" },
    { authorization: undefined, url: "/mcp?k=" },
    { authorization: undefined, url: "/mcp?other=token" },
  ]) {
    expect(McpHttpServer.readRequestToken(input)).toBe("");
  }
});

it("falls back to the URL when the Authorization header is present but empty", () => {
  expect(
    McpHttpServer.readRequestToken({ authorization: "Bearer  ", url: "/mcp?k=fallback" }),
  ).toBe("fallback");
});

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
