/**
 * HTTP routes for shared MCP servers: the per-server MCP endpoint agents call
 * with their thread credential, and the OAuth callback a sign-in returns to.
 *
 * The endpoint speaks stateless streamable HTTP: each POST carries one
 * JSON-RPC message and gets a JSON reply. Only tools are proxied.
 *
 * @module mcp/SharedMcpHttp
 */
import { sharedMcpServerKey } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerSettingsService } from "../serverSettings.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import {
  SHARED_MCP_OAUTH_CALLBACK_PATH,
  SHARED_MCP_PATH_SEGMENT,
  SharedMcpProxy,
  type SharedMcpProxyError,
} from "./SharedMcpProxy.ts";

const ROUTE_PREFIX = `/mcp/${SHARED_MCP_PATH_SEGMENT}/`;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcRequest = {
  readonly jsonrpc?: unknown;
  readonly id?: string | number | null;
  readonly method?: unknown;
  readonly params?: Record<string, unknown>;
};

const reply = (id: JsonRpcRequest["id"], result: unknown) =>
  HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: id ?? null, result });
const replyError = (id: JsonRpcRequest["id"], code: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** A tool call that can't reach the server is a tool error the agent can read, not a transport failure. */
const toolError = (error: SharedMcpProxyError) => ({
  isError: true,
  content: [{ type: "text", text: error.message }],
});

const handleMcp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const authorization = request.headers.authorization;
  const token =
    authorization?.startsWith("Bearer ") === true
      ? authorization.slice("Bearer ".length).trim()
      : "";
  if ((yield* registry.resolve(token)) === undefined) {
    return HttpServerResponse.text("Unauthorized", { status: 401 });
  }

  const pathname = new URL(request.originalUrl, "http://localhost").pathname;
  const key = decodeURIComponent(pathname.slice(ROUTE_PREFIX.length));
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(Effect.orDie);
  const server = settings.sharedMcpServers.find(
    (entry) => entry.enabled && sharedMcpServerKey(entry) === key,
  );
  if (server === undefined) return HttpServerResponse.text("Not Found", { status: 404 });

  const message = (yield* request.json.pipe(Effect.orElseSucceed(() => undefined))) as
    | JsonRpcRequest
    | undefined;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return replyError(null, -32600, "Expected one JSON-RPC message.");
  }
  // Notifications and responses need no reply.
  if (message.id === undefined || typeof message.method !== "string") {
    return HttpServerResponse.empty({ status: 202 });
  }
  const proxy = yield* SharedMcpProxy;
  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      return reply(message.id, {
        protocolVersion:
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: "1.0.0" },
      });
    }
    case "ping":
      return reply(message.id, {});
    case "tools/list":
      return yield* proxy.listTools(server, message.params).pipe(
        Effect.map((result) => reply(message.id, result)),
        Effect.catch((error) => Effect.succeed(replyError(message.id, -32000, error.message))),
      );
    case "tools/call":
      return yield* proxy.callTool(server, message.params).pipe(
        Effect.map((result) => reply(message.id, result)),
        Effect.catch((error) => Effect.succeed(reply(message.id, toolError(error)))),
      );
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

/** Public: the provider sends the browser here; the one-time `state` ties it to a sign-in T3 started. */
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
  return yield* (yield* SharedMcpProxy).finishSignIn(state, code).pipe(
    Effect.map(({ server }) =>
      page(
        `Signed in to ${escapeHtml(server)}`,
        "You can close this tab. Agents in T3 Code can use this server in their next session.",
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
  HttpRouter.add("GET", SHARED_MCP_OAUTH_CALLBACK_PATH, handleOAuthCallback),
);
