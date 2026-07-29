import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import { MCP_TOKEN_QUERY_PARAM, redactConnectorToken } from "./McpConnectorUrl.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { DelegateToolkitHandlersLive } from "./toolkits/agents/handlers.ts";
import { DelegateToolkit } from "./toolkits/agents/tools.ts";
import { WorkspaceToolkitHandlersLive } from "./toolkits/workspace/handlers.ts";
import { WorkspaceToolkit } from "./toolkits/workspace/tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

/**
 * Authentication needs the raw query string, but the downstream MCP handler
 * and any request logger must never receive the live connector credential.
 */
export const redactMcpRequestUrl = (
  request: HttpServerRequest.HttpServerRequest,
): HttpServerRequest.HttpServerRequest => ({
  ...request,
  url: redactConnectorToken(request.url),
});

/**
 * Reads the credential from the `Authorization` header, falling back to the
 * URL query parameter.
 *
 * The header is the preferred form and the only one local providers use. The
 * query parameter exists solely for ChatGPT Developer Mode connectors, whose
 * settings UI cannot send a custom header — see `McpConnectorUrl`.
 */
export const readRequestToken = (input: {
  readonly authorization: string | undefined;
  readonly url: string;
}): string => {
  if (input.authorization?.startsWith("Bearer ") === true) {
    const headerToken = input.authorization.slice("Bearer ".length).trim();
    if (headerToken.length > 0) return headerToken;
  }
  // The request URL is origin-relative, so it needs a base to parse against;
  // the base is discarded and never used for routing.
  const queryToken = new URL(input.url, "http://mcp.invalid").searchParams.get(
    MCP_TOKEN_QUERY_PARAM,
  );
  return queryToken?.trim() ?? "";
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map(
    (registry): McpAuthMiddleware =>
      Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = readRequestToken({
          authorization: request.headers.authorization,
          url: request.url,
        });
        const invocation = yield* registry.resolve(token);
        if (!invocation) {
          // Rejected credentials are the one thing worth a log line here, and
          // the URL is the useful part of it — but it carries the credential
          // for connector clients, so it is redacted before it is recorded.
          yield* Effect.logDebug("Rejected an MCP request with an invalid credential", {
            url: redactConnectorToken(request.url),
          });
          return unauthorized;
        }
        return yield* httpEffect.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, redactMcpRequestUrl(request)),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map(normalizeMcpHttpResponse),
        );
      }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

export const DelegateToolkitRegistrationLive = McpServer.toolkit(DelegateToolkit).pipe(
  Layer.provide(DelegateToolkitHandlersLive),
);

export const WorkspaceToolkitRegistrationLive = McpServer.toolkit(WorkspaceToolkit).pipe(
  Layer.provide(WorkspaceToolkitHandlersLive),
);

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  DelegateToolkitRegistrationLive,
  WorkspaceToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpTransportLive));
