/**
 * The per-plugin MCP endpoint agents call with their thread credential, and the OAuth callback.
 * The endpoint is stateless streamable HTTP: one JSON-RPC message in, one JSON reply out.
 */
import type { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { parseBearerToken } from "../auth/EnvironmentAuth.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { assertLiveCaller, loadCaller } from "../mcp/threadAccess.ts";
import { PLUGIN_OAUTH_CALLBACK_PATH, PluginProxy, type PluginProxyError } from "./PluginProxy.ts";
import { PluginService } from "./PluginService.ts";

const ROUTE_PREFIX = "/mcp/shared/";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const reply = (id: unknown, result: unknown) =>
  HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: id ?? null, result });
const replyError = (id: unknown, code: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** A tool call that can't reach the plugin is a tool error the agent reads, not a transport failure. */
const toolError = (error: PluginProxyError | OrchestratorMcpFailure) => ({
  isError: true,
  content: [{ type: "text", text: error.message }],
});

const handleMcp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // As on /mcp: no browser may reach this, before any credential is read.
  if (request.headers.origin !== undefined) return HttpServerResponse.empty({ status: 403 });
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const scope = yield* registry.resolve(parseBearerToken(request) ?? "");
  if (scope === undefined) return HttpServerResponse.text("Unauthorized", { status: 401 });

  const pathname = new URL(request.originalUrl, "http://localhost").pathname;
  const id = decodeURIComponent(pathname.slice(ROUTE_PREFIX.length));
  const plugins = yield* PluginService;
  const plugin = yield* plugins
    .forThread(scope.thread.threadId, id)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (plugin === undefined) return HttpServerResponse.text("Not Found", { status: 404 });

  const message = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
  if (!Predicate.isObject(message) || Array.isArray(message)) {
    return replyError(null, -32600, "Expected one JSON-RPC message.");
  }
  // Notifications and responses need no reply.
  if (message.id === undefined || typeof message.method !== "string") {
    return HttpServerResponse.empty({ status: 202 });
  }
  const params = Predicate.isObject(message.params) ? message.params : {};
  const proxy = yield* PluginProxy;
  const failed = (error: PluginProxyError) =>
    Effect.succeed(replyError(message.id, -32000, error.message));
  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return reply(message.id, {
        protocolVersion:
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: plugin.name, version: "1.0.0" },
      });
    }
    case "ping":
      return reply(message.id, {});
    case "tools/list":
      return yield* proxy.listTools(plugin).pipe(
        Effect.map((tools) => reply(message.id, { tools })),
        Effect.catch(failed),
      );
    case "tools/call": {
      if (typeof params.name !== "string") {
        return replyError(message.id, -32602, "tools/call needs a tool name.");
      }
      const name = params.name;
      const args = params.arguments;
      // The rule `plugin_call` has: an agent whose run ended, or left this thread, changes nothing.
      return yield* loadCaller().pipe(
        Effect.flatMap(assertLiveCaller),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.andThen(
          proxy.callTool(plugin, {
            name,
            arguments: Predicate.isObject(args) ? (args as Record<string, unknown>) : {},
          }),
        ),
        Effect.map((result) => reply(message.id, result)),
        Effect.catch((error) => Effect.succeed(reply(message.id, toolError(error)))),
      );
    }
    case "resources/list":
      return reply(message.id, { resources: [] });
    case "resources/templates/list":
      return reply(message.id, { resourceTemplates: [] });
    case "resources/read": {
      if (typeof params.uri !== "string") {
        return replyError(message.id, -32602, "resources/read needs a uri.");
      }
      return yield* proxy.readResource(plugin, params.uri).pipe(
        Effect.map((result) => reply(message.id, result)),
        Effect.catch(failed),
      );
    }
    default:
      return replyError(message.id, -32601, `${message.method} is not supported by this proxy.`);
  }
});

const page = (title: string, detail: string) =>
  HttpServerResponse.html(
    `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${title}</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">${title}</h1><p>${detail}</p></body>`,
  );
const escapeHtml = (value: string) =>
  value.replaceAll(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Public: the provider sends the browser here; the one-time `state` ties it to a started sign-in. */
const handleOAuthCallback = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = new URL(request.originalUrl, "http://localhost").searchParams;
  const state = params.get("state");
  const code = params.get("code");
  if (state === null || code === null) {
    const denied =
      params.get("error_description") ?? params.get("error") ?? "No code was returned.";
    return page("Sign-in did not finish", escapeHtml(denied));
  }
  return yield* (yield* PluginService).finishSignIn(state, code).pipe(
    Effect.map(({ plugin }) =>
      page(
        `Signed in to ${escapeHtml(plugin.label)}`,
        "You can close this tab. New conversations can use this plugin.",
      ),
    ),
    Effect.catch((error) => Effect.succeed(page("Sign-in failed", escapeHtml(error.message)))),
  );
});

export const layer = Layer.mergeAll(
  HttpRouter.add("POST", `${ROUTE_PREFIX}*`, handleMcp),
  // Clients may open a server-sent event stream or end a session; neither is needed here.
  HttpRouter.add(
    "GET",
    `${ROUTE_PREFIX}*`,
    HttpServerResponse.text("Method Not Allowed", { status: 405 }),
  ),
  HttpRouter.add("DELETE", `${ROUTE_PREFIX}*`, HttpServerResponse.empty({ status: 204 })),
  HttpRouter.add("GET", PLUGIN_OAUTH_CALLBACK_PATH, handleOAuthCallback),
);
