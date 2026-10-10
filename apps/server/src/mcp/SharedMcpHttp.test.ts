import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as SharedMcpHttp from "./SharedMcpHttp.ts";
import { SharedMcpProxy, SharedMcpProxyError } from "./SharedMcpProxy.ts";

const calls: Array<{ readonly server: string; readonly params: unknown }> = [];

const layerDependencies = Layer.mergeAll(
  Layer.mock(McpSessionRegistry.McpSessionRegistry)({
    resolve: (token) =>
      Effect.succeed(
        token === "thread-token"
          ? ({} as McpInvocationContext.McpThreadInvocationScope)
          : undefined,
      ),
  }),
  Layer.mock(SharedMcpProxy)({
    listTools: (server) => Effect.succeed({ tools: [{ name: `${server.name}_tool` }] }),
    callTool: (server, params) =>
      Effect.suspend(() => {
        calls.push({ server: server.name, params });
        return Effect.fail(
          new SharedMcpProxyError({
            server: server.name,
            message: "Sign in first.",
            needsSignIn: true,
          }),
        );
      }),
    finishSignIn: () =>
      Effect.fail(
        new SharedMcpProxyError({
          server: "",
          message: "This link has <expired>.",
          needsSignIn: true,
        }),
      ),
  }),
  ServerSettings.layerTest({
    sharedMcpServers: [
      { id: "docs", name: "docs", url: "http://127.0.0.1:9/mcp", enabled: true, headers: {} },
      { id: "off", name: "off", url: "http://127.0.0.1:9/mcp", enabled: false, headers: {} },
    ],
  }).pipe(Layer.orDie),
);

const makeClient = Effect.gen(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(SharedMcpHttp.layer, { disableListenLog: true }).pipe(
      Layer.provide(layerDependencies),
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );
  const client = Context.get(services, HttpClient.HttpClient);
  return {
    rpc: (path: string, body: unknown, token = "thread-token") =>
      client.execute(
        HttpClientRequest.post(path).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      ),
    get: (path: string) => client.get(path),
  };
});

it.effect("serves each enabled shared server to agents holding a thread credential", () =>
  Effect.gen(function* () {
    const { rpc } = yield* makeClient;

    assert.equal((yield* rpc("/mcp/shared/docs", {}, "stolen")).status, 401);
    assert.equal((yield* rpc("/mcp/shared/off", {})).status, 404);

    const initialize = yield* rpc("/mcp/shared/docs", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    });
    const initialized = (yield* initialize.json) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    assert.equal(initialized.result.protocolVersion, "2025-03-26");
    assert.equal(initialized.result.serverInfo.name, "docs");

    const notified = yield* rpc("/mcp/shared/docs", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(notified.status, 202);

    const listed = yield* rpc("/mcp/shared/docs", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(yield* listed.json, {
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "docs_tool" }] },
    });

    // An upstream failure comes back as a tool error the agent can read.
    const called = yield* rpc("/mcp/shared/docs", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search", arguments: { q: "x" } },
    });
    assert.deepEqual(yield* called.json, {
      jsonrpc: "2.0",
      id: 3,
      result: { isError: true, content: [{ type: "text", text: "Sign in first." }] },
    });
    assert.deepEqual(calls, [
      { server: "docs", params: { name: "search", arguments: { q: "x" } } },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("answers the OAuth callback with a page, escaping what it echoes", () =>
  Effect.gen(function* () {
    const { get } = yield* makeClient;
    const failed = yield* (yield* get("/api/mcp-oauth/callback?state=s&code=c")).text;
    assert.include(failed, "Sign-in failed");
    assert.include(failed, "This link has &#60;expired&#62;.");

    const denied = yield* (yield* get("/api/mcp-oauth/callback?error=access_denied")).text;
    assert.include(denied, "access_denied");
  }).pipe(Effect.scoped),
);
