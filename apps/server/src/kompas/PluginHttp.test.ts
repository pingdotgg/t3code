import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import { KompasError, type Plugin, ThreadId } from "@t3tools/contracts";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as PluginHttp from "./PluginHttp.ts";
import { PluginProxy, PluginProxyError } from "./PluginProxy.ts";
import { PluginService } from "./PluginService.ts";

const calls: Array<{ readonly plugin: string; readonly input: unknown }> = [];

const docs: Plugin = {
  id: "docs",
  name: "docs",
  label: "Docs",
  enabled: true,
  allConversations: true,
  transport: { type: "http", url: "http://127.0.0.1:9/mcp", headers: {} },
  disabledTools: [],
};

const layerDependencies = Layer.mergeAll(
  Layer.mock(McpSessionRegistry.McpSessionRegistry)({
    resolve: (token) =>
      Effect.succeed(
        token === "thread-token"
          ? ({
              thread: { threadId: ThreadId.make("thread") },
            } as McpInvocationContext.McpThreadInvocationScope)
          : undefined,
      ),
  }),
  Layer.mock(PluginService)({
    forThread: (_threadId, id) => Effect.succeed(id === "docs" ? docs : undefined),
    finishSignIn: () =>
      Effect.fail(
        new KompasError({ reason: "needs-sign-in", message: "This link has <expired>." }),
      ),
  }),
  Layer.mock(PluginProxy)({
    listTools: (plugin) =>
      Effect.succeed([{ name: `${plugin.name}_tool`, inputSchema: { type: "object" as const } }]),
    callTool: (plugin, input) =>
      Effect.suspend(() => {
        calls.push({ plugin: plugin.name, input });
        return Effect.fail(
          new PluginProxyError({
            plugin: plugin.label,
            message: "Sign in first.",
            needsSignIn: true,
          }),
        );
      }),
  }),
);

const makeClient = Effect.gen(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(PluginHttp.layer, { disableListenLog: true }).pipe(
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

it.effect("serves a conversation's plugins to agents holding its thread credential", () =>
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
      result: { tools: [{ name: "docs_tool", inputSchema: { type: "object" } }] },
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
      { plugin: "docs", input: { name: "search", arguments: { q: "x" } } },
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
