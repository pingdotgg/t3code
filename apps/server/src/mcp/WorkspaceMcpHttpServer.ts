import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { normalizeMcpHttpResponse } from "./McpHttpServer.ts";
import { WorkspaceToolkitHandlersLive } from "./toolkits/workspace/handlers.ts";
import { permitsUnauthenticatedWorkspaceClient } from "./toolkits/workspace/mapping.ts";
import { WorkspaceMcpAuth, type WorkspaceMcpPrincipal } from "./toolkits/workspace/principal.ts";
import { WorkspaceToolkit } from "./toolkits/workspace/tools.ts";

export const WORKSPACE_MCP_PATH = "/mcp/workspace";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message:
      "Workspace MCP requires a T3 environment bearer token, or a loopback client such as OpenAI tunnel-client.",
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
  WorkspaceMcpAuth
>;

type WorkspaceMcpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

function requestRemoteAddress(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const source = request.source;
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: { readonly remoteAddress?: string | null };
  };
  return candidate.socket?.remoteAddress ?? candidate.remoteAddress ?? undefined;
}

const makeWorkspaceMcpAuthMiddleware = EnvironmentAuth.EnvironmentAuth.pipe(
  Effect.map((serverAuth): WorkspaceMcpAuthMiddleware =>
    Effect.fn("WorkspaceMcpHttpServer.authenticateRequest")(function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const loopback = permitsUnauthenticatedWorkspaceClient(
        requestRemoteAddress(request),
        request.headers.origin,
      );
      const principal = yield* serverAuth.authenticateHttpRequest(request).pipe(
        Effect.map((session): WorkspaceMcpPrincipal | null => ({
          kind: "session",
          scopes: new Set(session.scopes),
        })),
        Effect.catch((error) => {
          if (error._tag === "ServerAuthMissingCredentialError" && loopback) {
            return Effect.succeed<WorkspaceMcpPrincipal | null>({ kind: "loopback" });
          }
          return Effect.logWarning("rejected workspace MCP request", {
            reason: EnvironmentAuth.isServerAuthCredentialError(error)
              ? EnvironmentAuth.serverAuthCredentialReason(error)
              : "internal_error",
          }).pipe(Effect.as(null));
        }),
      );
      if (principal == null) {
        return unauthorized;
      }
      return yield* httpEffect.pipe(
        Effect.provideService(WorkspaceMcpAuth, principal),
        Effect.map(normalizeMcpHttpResponse),
      );
    }),
  ),
  Effect.withSpan("WorkspaceMcpHttpServer.makeAuthMiddleware"),
);

const WorkspaceMcpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: WorkspaceMcpAuth;
}>()(makeWorkspaceMcpAuthMiddleware).layer;

const WorkspaceToolkitRegistrationLive = McpServer.toolkit(WorkspaceToolkit).pipe(
  Layer.provide(WorkspaceToolkitHandlersLive),
);

const WorkspaceMcpTransportLive = McpServer.layerHttp({
  name: "T3 Code Workspace",
  version: packageJson.version,
  path: WORKSPACE_MCP_PATH,
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(WorkspaceMcpAuthMiddlewareLive));

export const layer = WorkspaceToolkitRegistrationLive.pipe(
  Layer.provideMerge(WorkspaceMcpTransportLive),
);
